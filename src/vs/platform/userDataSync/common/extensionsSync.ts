/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IUserDataSyncStoreService, ISyncExtension, IUserDataSyncLogService, IUserDataSynchroniser, SyncResource, IUserDataSyncResourceEnablementService,
	IUserDataSyncBackupStoreService, ISyncResourceHandle, USER_DATA_SYNC_SCHEME, IRemoteUserData, ISyncData, IResourcePreview
} from 'vs/platform/userDataSync/common/userDataSync';
import { Event } from 'vs/base/common/event';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IExtensionManagementService, IExtensionGalleryService, IGlobalExtensionEnablementService, ILocalExtension } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionType, IExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IFileService } from 'vs/platform/files/common/files';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { merge, getIgnoredExtensions, IMergeResult } from 'vs/platform/userDataSync/common/extensionsMerge';
import { AbstractSynchroniser, ISyncResourcePreview } from 'vs/platform/userDataSync/common/abstractSynchronizer';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { URI } from 'vs/base/common/uri';
import { joinPath, dirname, basename, isEqual } from 'vs/base/common/resources';
import { format } from 'vs/base/common/jsonFormatter';
import { applyEdits } from 'vs/base/common/jsonEdit';
import { compare } from 'vs/base/common/strings';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { CancellationToken } from 'vs/base/common/cancellation';

interface IExtensionsSyncPreview extends ISyncResourcePreview {
	readonly localExtensions: ISyncExtension[];
	readonly lastSyncUserData: ILastSyncUserData | null;
	readonly added: ISyncExtension[];
	readonly removed: IExtensionIdentifier[];
	readonly updated: ISyncExtension[];
	readonly remote: ISyncExtension[] | null;
	readonly skippedExtensions: ISyncExtension[];
}

interface ILastSyncUserData extends IRemoteUserData {
	skippedExtensions: ISyncExtension[] | undefined;
}

export class ExtensionsSynchroniser extends AbstractSynchroniser implements IUserDataSynchroniser {

	private static readonly EXTENSIONS_DATA_URI = URI.from({ scheme: USER_DATA_SYNC_SCHEME, authority: 'extensions', path: `/current.json` });
	/*
		Version 3 - Introduce installed property to skip installing built in extensions
	*/
	protected readonly version: number = 3;
	protected isEnabled(): boolean { return super.isEnabled() && this.extensionGalleryService.isEnabled(); }
	private readonly localPreviewResource: URI = joinPath(this.syncPreviewFolder, 'extensions.json');
	private readonly remotePreviewResource: URI = this.localPreviewResource.with({ scheme: USER_DATA_SYNC_SCHEME });

	constructor(
		@IEnvironmentService environmentService: IEnvironmentService,
		@IFileService fileService: IFileService,
		@IStorageService storageService: IStorageService,
		@IUserDataSyncStoreService userDataSyncStoreService: IUserDataSyncStoreService,
		@IUserDataSyncBackupStoreService userDataSyncBackupStoreService: IUserDataSyncBackupStoreService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IGlobalExtensionEnablementService private readonly extensionEnablementService: IGlobalExtensionEnablementService,
		@IUserDataSyncLogService logService: IUserDataSyncLogService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IUserDataSyncResourceEnablementService userDataSyncResourceEnablementService: IUserDataSyncResourceEnablementService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(SyncResource.Extensions, fileService, environmentService, storageService, userDataSyncStoreService, userDataSyncBackupStoreService, userDataSyncResourceEnablementService, telemetryService, logService, configurationService);
		this._register(
			Event.debounce(
				Event.any<any>(
					Event.filter(this.extensionManagementService.onDidInstallExtension, (e => !!e.gallery)),
					Event.filter(this.extensionManagementService.onDidUninstallExtension, (e => !e.error)),
					this.extensionEnablementService.onDidChangeEnablement),
				() => undefined, 500)(() => this.triggerLocalChange()));
	}

	protected async generatePullPreview(remoteUserData: IRemoteUserData, lastSyncUserData: ILastSyncUserData | null, token: CancellationToken): Promise<IExtensionsSyncPreview> {
		const installedExtensions = await this.extensionManagementService.getInstalled();
		const localExtensions = this.getLocalExtensions(installedExtensions);
		const ignoredExtensions = getIgnoredExtensions(installedExtensions, this.configurationService);
		if (remoteUserData.syncData !== null) {
			const remoteExtensions = await this.parseAndMigrateExtensions(remoteUserData.syncData);
			const mergeResult = merge(localExtensions, remoteExtensions, localExtensions, [], ignoredExtensions);
			const { added, removed, updated, remote } = mergeResult;
			const resourcePreviews: IResourcePreview[] = this.getResourcePreviews(mergeResult);
			return {
				remoteUserData, lastSyncUserData,
				added, removed, updated, remote, localExtensions, skippedExtensions: [],
				hasLocalChanged: resourcePreviews.some(({ hasLocalChanged }) => hasLocalChanged),
				hasRemoteChanged: resourcePreviews.some(({ hasRemoteChanged }) => hasRemoteChanged),
				hasConflicts: false,
				isLastSyncFromCurrentMachine: false,
				resourcePreviews,
			};
		} else {
			return {
				remoteUserData, lastSyncUserData,
				added: [], removed: [], updated: [], remote: null, localExtensions, skippedExtensions: [],
				hasLocalChanged: false,
				hasRemoteChanged: false,
				hasConflicts: false,
				isLastSyncFromCurrentMachine: false,
				resourcePreviews: [],
			};
		}
	}

	protected async generatePushPreview(remoteUserData: IRemoteUserData, lastSyncUserData: ILastSyncUserData | null, token: CancellationToken): Promise<IExtensionsSyncPreview> {
		const installedExtensions = await this.extensionManagementService.getInstalled();
		const localExtensions = this.getLocalExtensions(installedExtensions);
		const ignoredExtensions = getIgnoredExtensions(installedExtensions, this.configurationService);
		const mergeResult = merge(localExtensions, null, null, [], ignoredExtensions);
		const { added, removed, updated, remote } = mergeResult;
		const resourcePreviews: IResourcePreview[] = this.getResourcePreviews(mergeResult);
		return {
			added, removed, updated, remote, remoteUserData, localExtensions, skippedExtensions: [], lastSyncUserData,
			hasLocalChanged: resourcePreviews.some(({ hasLocalChanged }) => hasLocalChanged),
			hasRemoteChanged: resourcePreviews.some(({ hasRemoteChanged }) => hasRemoteChanged),
			isLastSyncFromCurrentMachine: false,
			hasConflicts: false,
			resourcePreviews
		};
	}

	protected async generateReplacePreview(syncData: ISyncData, remoteUserData: IRemoteUserData, lastSyncUserData: ILastSyncUserData | null): Promise<IExtensionsSyncPreview> {
		const installedExtensions = await this.extensionManagementService.getInstalled();
		const localExtensions = this.getLocalExtensions(installedExtensions);
		const syncExtensions = await this.parseAndMigrateExtensions(syncData);
		const ignoredExtensions = getIgnoredExtensions(installedExtensions, this.configurationService);
		const mergeResult = merge(localExtensions, syncExtensions, localExtensions, [], ignoredExtensions);
		const { added, removed, updated } = mergeResult;
		const resourcePreviews: IResourcePreview[] = this.getResourcePreviews(mergeResult);
		return {
			added, removed, updated, remote: syncExtensions, remoteUserData, localExtensions, skippedExtensions: [], lastSyncUserData,
			hasLocalChanged: resourcePreviews.some(({ hasLocalChanged }) => hasLocalChanged),
			hasRemoteChanged: true,
			isLastSyncFromCurrentMachine: false,
			hasConflicts: false,
			resourcePreviews
		};
	}

	protected async generatePreview(remoteUserData: IRemoteUserData, lastSyncUserData: ILastSyncUserData | null): Promise<IExtensionsSyncPreview> {
		const remoteExtensions: ISyncExtension[] | null = remoteUserData.syncData ? await this.parseAndMigrateExtensions(remoteUserData.syncData) : null;
		const skippedExtensions: ISyncExtension[] = lastSyncUserData ? lastSyncUserData.skippedExtensions || [] : [];
		const isLastSyncFromCurrentMachine = await this.isLastSyncFromCurrentMachine(remoteUserData);
		let lastSyncExtensions: ISyncExtension[] | null = null;
		if (lastSyncUserData === null) {
			if (isLastSyncFromCurrentMachine) {
				lastSyncExtensions = await this.parseAndMigrateExtensions(remoteUserData.syncData!);
			}
		} else {
			lastSyncExtensions = await this.parseAndMigrateExtensions(lastSyncUserData.syncData!);
		}

		const installedExtensions = await this.extensionManagementService.getInstalled();
		const localExtensions = this.getLocalExtensions(installedExtensions);
		const ignoredExtensions = getIgnoredExtensions(installedExtensions, this.configurationService);

		if (remoteExtensions) {
			this.logService.trace(`${this.syncResourceLogLabel}: Merging remote extensions with local extensions...`);
		} else {
			this.logService.trace(`${this.syncResourceLogLabel}: Remote extensions does not exist. Synchronizing extensions for the first time.`);
		}

		const mergeResult = merge(localExtensions, remoteExtensions, lastSyncExtensions, skippedExtensions, ignoredExtensions);
		const { added, removed, updated, remote } = mergeResult;
		const resourcePreviews: IResourcePreview[] = this.getResourcePreviews(mergeResult);

		return {
			added,
			removed,
			updated,
			remote,
			skippedExtensions,
			remoteUserData,
			localExtensions,
			lastSyncUserData,
			hasLocalChanged: resourcePreviews.some(({ hasLocalChanged }) => hasLocalChanged),
			hasRemoteChanged: resourcePreviews.some(({ hasRemoteChanged }) => hasRemoteChanged),
			isLastSyncFromCurrentMachine,
			hasConflicts: false,
			resourcePreviews
		};
	}

	protected async updatePreviewWithConflict(preview: IExtensionsSyncPreview, conflictResource: URI, content: string, token: CancellationToken): Promise<IExtensionsSyncPreview> {
		throw new Error(`${this.syncResourceLogLabel}: Conflicts should not occur`);
	}

	protected async applyPreview({ added, removed, updated, remote, remoteUserData, skippedExtensions, lastSyncUserData, localExtensions, hasLocalChanged, hasRemoteChanged }: IExtensionsSyncPreview, forcePush: boolean): Promise<void> {

		if (!hasLocalChanged && !hasRemoteChanged) {
			this.logService.info(`${this.syncResourceLogLabel}: No changes found during synchronizing extensions.`);
		}

		if (hasLocalChanged) {
			await this.backupLocal(JSON.stringify(localExtensions));
			skippedExtensions = await this.updateLocalExtensions(added, removed, updated, skippedExtensions);
		}

		if (remote) {
			// update remote
			this.logService.trace(`${this.syncResourceLogLabel}: Updating remote extensions...`);
			const content = JSON.stringify(remote);
			remoteUserData = await this.updateRemoteUserData(content, forcePush ? null : remoteUserData.ref);
			this.logService.info(`${this.syncResourceLogLabel}: Updated remote extensions`);
		}

		if (lastSyncUserData?.ref !== remoteUserData.ref) {
			// update last sync
			this.logService.trace(`${this.syncResourceLogLabel}: Updating last synchronized extensions...`);
			await this.updateLastSyncUserData(remoteUserData, { skippedExtensions });
			this.logService.info(`${this.syncResourceLogLabel}: Updated last synchronized extensions`);
		}
	}

	private getResourcePreviews({ added, removed, updated, remote }: IMergeResult): IResourcePreview[] {
		const hasLocalChanged = added.length > 0 || removed.length > 0 || updated.length > 0;
		const hasRemoteChanged = remote !== null;
		return [{
			hasLocalChanged,
			hasConflicts: false,
			hasRemoteChanged,
			localResouce: ExtensionsSynchroniser.EXTENSIONS_DATA_URI,
			remoteResource: this.remotePreviewResource
		}];
	}

	async getAssociatedResources({ uri }: ISyncResourceHandle): Promise<{ resource: URI, comparableResource?: URI }[]> {
		return [{ resource: joinPath(uri, 'extensions.json'), comparableResource: ExtensionsSynchroniser.EXTENSIONS_DATA_URI }];
	}

	async resolveContent(uri: URI): Promise<string | null> {
		if (isEqual(uri, ExtensionsSynchroniser.EXTENSIONS_DATA_URI)) {
			const installedExtensions = await this.extensionManagementService.getInstalled();
			const localExtensions = this.getLocalExtensions(installedExtensions);
			return this.format(localExtensions);
		}

		let content = await super.resolveContent(uri);
		if (content) {
			return content;
		}

		content = await super.resolveContent(dirname(uri));
		if (content) {
			const syncData = this.parseSyncData(content);
			if (syncData) {
				switch (basename(uri)) {
					case 'extensions.json':
						return this.format(this.parseExtensions(syncData));
				}
			}
		}

		return null;
	}

	private format(extensions: ISyncExtension[]): string {
		extensions.sort((e1, e2) => {
			if (!e1.identifier.uuid && e2.identifier.uuid) {
				return -1;
			}
			if (e1.identifier.uuid && !e2.identifier.uuid) {
				return 1;
			}
			return compare(e1.identifier.id, e2.identifier.id);
		});
		const content = JSON.stringify(extensions);
		const edits = format(content, undefined, {});
		return applyEdits(content, edits);
	}

	async hasLocalData(): Promise<boolean> {
		try {
			const installedExtensions = await this.extensionManagementService.getInstalled();
			const localExtensions = this.getLocalExtensions(installedExtensions);
			if (localExtensions.some(e => e.installed || e.disabled)) {
				return true;
			}
		} catch (error) {
			/* ignore error */
		}
		return false;
	}

	private async updateLocalExtensions(added: ISyncExtension[], removed: IExtensionIdentifier[], updated: ISyncExtension[], skippedExtensions: ISyncExtension[]): Promise<ISyncExtension[]> {
		const removeFromSkipped: IExtensionIdentifier[] = [];
		const addToSkipped: ISyncExtension[] = [];

		if (removed.length) {
			const installedExtensions = await this.extensionManagementService.getInstalled(ExtensionType.User);
			const extensionsToRemove = installedExtensions.filter(({ identifier }) => removed.some(r => areSameExtensions(identifier, r)));
			await Promise.all(extensionsToRemove.map(async extensionToRemove => {
				this.logService.trace(`${this.syncResourceLogLabel}: Uninstalling local extension...`, extensionToRemove.identifier.id);
				await this.extensionManagementService.uninstall(extensionToRemove);
				this.logService.info(`${this.syncResourceLogLabel}: Uninstalled local extension.`, extensionToRemove.identifier.id);
				removeFromSkipped.push(extensionToRemove.identifier);
			}));
		}

		if (added.length || updated.length) {
			await Promise.all([...added, ...updated].map(async e => {
				const installedExtensions = await this.extensionManagementService.getInstalled();
				const installedExtension = installedExtensions.filter(installed => areSameExtensions(installed.identifier, e.identifier))[0];

				// Builtin Extension: Sync only enablement state
				if (installedExtension && installedExtension.type === ExtensionType.System) {
					if (e.disabled) {
						this.logService.trace(`${this.syncResourceLogLabel}: Disabling extension...`, e.identifier.id);
						await this.extensionEnablementService.disableExtension(e.identifier);
						this.logService.info(`${this.syncResourceLogLabel}: Disabled extension`, e.identifier.id);
					} else {
						this.logService.trace(`${this.syncResourceLogLabel}: Enabling extension...`, e.identifier.id);
						await this.extensionEnablementService.enableExtension(e.identifier);
						this.logService.info(`${this.syncResourceLogLabel}: Enabled extension`, e.identifier.id);
					}
					removeFromSkipped.push(e.identifier);
					return;
				}

				const extension = await this.extensionGalleryService.getCompatibleExtension(e.identifier, e.version);
				if (extension) {
					try {
						if (e.disabled) {
							this.logService.trace(`${this.syncResourceLogLabel}: Disabling extension...`, e.identifier.id, extension.version);
							await this.extensionEnablementService.disableExtension(extension.identifier);
							this.logService.info(`${this.syncResourceLogLabel}: Disabled extension`, e.identifier.id, extension.version);
						} else {
							this.logService.trace(`${this.syncResourceLogLabel}: Enabling extension...`, e.identifier.id, extension.version);
							await this.extensionEnablementService.enableExtension(extension.identifier);
							this.logService.info(`${this.syncResourceLogLabel}: Enabled extension`, e.identifier.id, extension.version);
						}
						// Install only if the extension does not exist
						if (!installedExtension || installedExtension.manifest.version !== extension.version) {
							this.logService.trace(`${this.syncResourceLogLabel}: Installing extension...`, e.identifier.id, extension.version);
							await this.extensionManagementService.installFromGallery(extension);
							this.logService.info(`${this.syncResourceLogLabel}: Installed extension.`, e.identifier.id, extension.version);
							removeFromSkipped.push(extension.identifier);
						}
					} catch (error) {
						addToSkipped.push(e);
						this.logService.error(error);
						this.logService.info(`${this.syncResourceLogLabel}: Skipped synchronizing extension`, extension.displayName || extension.identifier.id);
					}
				} else {
					addToSkipped.push(e);
				}
			}));
		}

		const newSkippedExtensions: ISyncExtension[] = [];
		for (const skippedExtension of skippedExtensions) {
			if (!removeFromSkipped.some(e => areSameExtensions(e, skippedExtension.identifier))) {
				newSkippedExtensions.push(skippedExtension);
			}
		}
		for (const skippedExtension of addToSkipped) {
			if (!newSkippedExtensions.some(e => areSameExtensions(e.identifier, skippedExtension.identifier))) {
				newSkippedExtensions.push(skippedExtension);
			}
		}
		return newSkippedExtensions;
	}

	private async parseAndMigrateExtensions(syncData: ISyncData): Promise<ISyncExtension[]> {
		const extensions = this.parseExtensions(syncData);
		if (syncData.version === 1
			|| syncData.version === 2
		) {
			const systemExtensions = await this.extensionManagementService.getInstalled(ExtensionType.System);
			for (const extension of extensions) {
				// #region Migration from v1 (enabled -> disabled)
				if (syncData.version === 1) {
					if ((<any>extension).enabled === false) {
						extension.disabled = true;
					}
					delete (<any>extension).enabled;
				}
				// #endregion

				// #region Migration from v2 (set installed property on extension)
				if (syncData.version === 2) {
					if (systemExtensions.every(installed => !areSameExtensions(installed.identifier, extension.identifier))) {
						extension.installed = true;
					}
				}
				// #endregion
			}
		}
		return extensions;
	}

	private parseExtensions(syncData: ISyncData): ISyncExtension[] {
		return JSON.parse(syncData.content);
	}

	private getLocalExtensions(installedExtensions: ILocalExtension[]): ISyncExtension[] {
		const disabledExtensions = this.extensionEnablementService.getDisabledExtensions();
		return installedExtensions
			.map(({ identifier, type }) => {
				const syncExntesion: ISyncExtension = { identifier };
				if (disabledExtensions.some(disabledExtension => areSameExtensions(disabledExtension, identifier))) {
					syncExntesion.disabled = true;
				}
				if (type === ExtensionType.User) {
					syncExntesion.installed = true;
				}
				return syncExntesion;
			});
	}

}
