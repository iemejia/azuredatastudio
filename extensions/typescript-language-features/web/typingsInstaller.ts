/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * This file implements the global typings installer API for web clients. It
 * uses [nassun](https://docs.rs/nassun) and
 * [node-maintainer](https://docs.rs/node-maintainer) to install typings
 * in-memory (and maybe eventually cache them in IndexedDB?).
 *
 * Implementing a typings installer involves implementing two parts:
 *
 * -> ITypingsInstaller: the "top level" interface that tsserver uses to
 * request typings. Implementers of this interface are what actually get
 * passed to tsserver.
 *
 * -> TypingsInstaller: an abstract class that implements a good chunk of
 * the "generic" functionality for what ITypingsInstaller needs to do. For
 * implementation detail reasons, it does this in a "server/client" model of
 * sorts. In our case, we don't need a separate process, or even _quite_ a
 * pure "server/client" model, so we play along a bit for the sake of reusing
 * the stuff the abstract class is already doing for us.
 */

import { PackageManager, PackageType } from '@vscode/ts-package-manager';
import { join } from 'path';
import * as ts from 'typescript/lib/tsserverlibrary';
import { NameValidationResult, validatePackageNameWorker } from './jsTyping';

type InstallerResponse = ts.server.PackageInstalledResponse | ts.server.SetTypings | ts.server.InvalidateCachedTypings | ts.server.BeginInstallTypes | ts.server.EndInstallTypes | ts.server.WatchTypingLocations;

/**
 * The "server" part of the "server/client" model. This is the part that
 * actually gets instantiated and passed to tsserver.
 */
export default class WebTypingsInstallerClient implements ts.server.ITypingsInstaller {

	private projectService: ts.server.ProjectService | undefined;

	private requestedRegistry = false;

	private typesRegistryCache: Map<string, ts.MapLike<string>> = new Map();

	private readonly server: Promise<WebTypingsInstallerServer>;

	constructor(
		private readonly fs: ts.server.ServerHost,
		readonly globalTypingsCacheLocation: string,
	) {
		this.server = WebTypingsInstallerServer.initialize(
			(response: InstallerResponse) => this.handleResponse(response),
			this.fs,
			globalTypingsCacheLocation
		);
	}

	/**
	 * TypingsInstaller expects a "server/client" model, and as such, some of
	 * its methods are implemented in terms of sending responses back to a
	 * client. This method is a catch-all for those responses generated by
	 * TypingsInstaller internals.
	 */
	private async handleResponse(response: InstallerResponse): Promise<void> {
		switch (response.kind) {
			case 'action::packageInstalled':
			case 'action::invalidate':
			case 'action::set':
				this.projectService!.updateTypingsForProject(response);
				break;
			case 'event::beginInstallTypes':
			case 'event::endInstallTypes':
				// Don't care.
				break;
			default:
				throw new Error(`unexpected response: ${response}`);
		}
	}

	// NB(kmarchan): this is a code action that expects an actual NPM-specific
	// installation. We shouldn't mess with this ourselves.
	async installPackage(_options: ts.server.InstallPackageOptionsWithProject): Promise<ts.ApplyCodeActionCommandResult> {
		throw new Error('not implemented');
	}

	// NB(kmarchan): As far as I can tell, this is only ever used for
	// completions?
	isKnownTypesPackageName(packageName: string): boolean {
		console.log('isKnownTypesPackageName', packageName);
		const looksLikeValidName = validatePackageNameWorker(packageName, true);
		if (looksLikeValidName.result !== NameValidationResult.Ok) {
			return false;
		}

		if (this.requestedRegistry) {
			return !!this.typesRegistryCache && this.typesRegistryCache.has(packageName);
		}

		this.requestedRegistry = true;
		this.server.then(s => this.typesRegistryCache = s.typesRegistry);
		return false;
	}

	enqueueInstallTypingsRequest(p: ts.server.Project, typeAcquisition: ts.TypeAcquisition, unresolvedImports: ts.SortedReadonlyArray<string>): void {
		console.log('enqueueInstallTypingsRequest', typeAcquisition, unresolvedImports);
		const req = ts.server.createInstallTypingsRequest(p, typeAcquisition, unresolvedImports);
		this.server.then(s => s.install(req));
	}

	attach(projectService: ts.server.ProjectService): void {
		this.projectService = projectService;
	}

	onProjectClosed(_projectService: ts.server.Project): void {
		// noop
	}
}

/**
 * Internal implementation of the "server" part of the "server/client" model.
 * This takes advantage of the existing TypingsInstaller to reuse a lot of
 * already-implemented logic around package installation, but with
 * installation details handled by Nassun/Node Maintainer.
 */
class WebTypingsInstallerServer extends ts.server.typingsInstaller.TypingsInstaller {

	private static readonly typesRegistryPackageName = 'types-registry';

	private constructor(
		override typesRegistry: Map<string, ts.MapLike<string>>,
		private readonly handleResponse: (response: InstallerResponse) => void,
		fs: ts.server.ServerHost,
		private readonly packageManager: PackageManager,
		globalTypingsCachePath: string,
	) {
		super(fs, globalTypingsCachePath, join(globalTypingsCachePath, 'fakeSafeList') as ts.Path, join(globalTypingsCachePath, 'fakeTypesMapLocation') as ts.Path, Infinity);
	}

	/**
	 * Because loading the typesRegistry is an async operation for us, we need
	 * to have a separate "constructor" that will be used by
	 * WebTypingsInstallerClient.
	 *
	 * @returns a promise that resolves to a WebTypingsInstallerServer
	 */
	static async initialize(
		handleResponse: (response: InstallerResponse) => void,
		fs: ts.server.ServerHost,
		globalTypingsCachePath: string,
	): Promise<WebTypingsInstallerServer> {
		const pm = new PackageManager(fs);
		const pkgJson = join(globalTypingsCachePath, 'package.json');
		if (!fs.fileExists(pkgJson)) {
			fs.writeFile(pkgJson, '{"private":true}');
		}
		const resolved = await pm.resolveProject(globalTypingsCachePath, {
			addPackages: [this.typesRegistryPackageName]
		});
		await resolved.restore();

		const registry = new Map<string, ts.MapLike<string>>();
		const indexPath = join(globalTypingsCachePath, 'node_modules/types-registry/index.json');
		const index = WebTypingsInstallerServer.readJson(fs, indexPath);
		for (const [packageName, entry] of Object.entries(index.entries)) {
			registry.set(packageName, entry as ts.MapLike<string>);
		}
		console.log('ATA registry loaded');
		return new WebTypingsInstallerServer(registry, handleResponse, fs, pm, globalTypingsCachePath);
	}

	/**
	 * Implements the actual logic of installing a set of given packages. It
	 * does this by looking up the latest versions of those packages using
	 * Nassun, then handing Node Maintainer the updated package.json to run a
	 * full install (modulo existing lockfiles, which can make this faster).
	 */
	protected override installWorker(requestId: number, packageNames: string[], cwd: string, onRequestCompleted: ts.server.typingsInstaller.RequestCompletedAction): void {
		console.log('installWorker', requestId, cwd);
		(async () => {
			try {
				const resolved = await this.packageManager.resolveProject(cwd, {
					addPackages: packageNames,
					packageType: PackageType.DevDependency
				});
				await resolved.restore();
				onRequestCompleted(true);
			} catch (e) {
				onRequestCompleted(false);
			}
		})();
	}

	/**
	 * This is a thing that TypingsInstaller uses internally to send
	 * responses, and we'll need to handle this in the Client later.
	 */
	protected override sendResponse(response: InstallerResponse): void {
		this.handleResponse(response);
	}

	/**
	 * What it says on the tin. Reads a JSON file from the given path. Throws
	 * if the file doesn't exist (as opposed to returning `undefined`, like
	 * fs.readFile does).
	 */
	private static readJson(fs: ts.server.ServerHost, path: string): any {
		const data = fs.readFile(path);
		if (!data) {
			throw new Error('Failed to read file: ' + path);
		}
		return JSON.parse(data.trim());
	}
}
