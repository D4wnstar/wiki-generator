import { Notice, Plugin, TFile } from "obsidian"
import {
	massAddPublish,
	massSetPublishState,
	pingDeployHook,
	syncNotes,
} from "src/commands"
import { addWikiPublishToNewFile } from "src/events"
import { checkForTemplateUpdates } from "src/repository"
import {
	DEFAULT_SETTINGS,
	WikiGeneratorSettingTab,
	WikiGeneratorSettings,
	addFolderContextMenu,
} from "src/settings"
import { BlockModal, PropertyModal, UserListModal } from "src/modals"
import { getUsersFromRemote } from "src/database/operations"
import { isWebsiteUpToDate } from "src/utils"

export default class WikiGeneratorPlugin extends Plugin {
	settings: WikiGeneratorSettings

	async onload() {
		await this.loadSettings()

		// Shorthands for common variables
		const settings = this.settings
		const workspace = this.app.workspace

		// Check for website updates on startup
		if (
			settings.githubUsername &&
			settings.githubRepoName &&
			settings.githubRepoToken &&
			settings.githubCheckUpdatesOnStartup
		) {
			await isWebsiteUpToDate(settings, 10000)
		}

		// Automatically add the wiki-publish: true property on file creation
		// if the user allows it in the settings
		workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					// Ignore non-files being created or if this feature is disabled
					if (
						!(file instanceof TFile) ||
						!settings.autopublishNotes
					) {
						return
					}
					addWikiPublishToNewFile(file, settings, workspace)
				})
			)
		})

		// Add context menu settings for public/private folders
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, folder) =>
				addFolderContextMenu(settings, this, menu, folder)
			)
		)

		const sync = async (reset: boolean) => {
			try {
				await syncNotes(this.app.vault, settings, reset)
			} catch (error) {
				console.error("An error occured while uploading notes.", error)
				new Notice(
					`An error occured while uploading notes. See console (CTRL+Shift+I) for details. ${error}`,
					0
				)
			}
		}

		// Add a ribbon icon to upload notes
		this.addRibbonIcon(
			"cloud-upload",
			"Sync notes",
			async () => await sync(false)
		)

		// And a command for the same thing
		this.addCommand({
			id: "sync-notes",
			name: "Sync notes",
			callback: async () => await sync(false),
		})

		this.addCommand({
			id: "sync-notes-reset",
			name: "Clear database, then sync notes",
			callback: async () => await sync(true),
		})

		// Commands to make setting properties easier
		this.addCommand({
			id: "mass-add-publish",
			name: "Add 'wiki-publish' to everything (restricted)",
			callback: () => massAddPublish(true, settings, this.app.vault),
		})

		this.addCommand({
			id: "mass-set-publish-true",
			name: "Set 'wiki-publish' to true on everything (restricted)",
			callback: () => massSetPublishState(true, settings, this.app.vault),
		})

		this.addCommand({
			id: "mass-set-publish-false",
			name: "Set 'wiki-publish' to false on everything (restricted)",
			callback: () =>
				massSetPublishState(false, settings, this.app.vault),
		})

		this.addCommand({
			id: "add-update-wiki-property",
			name: "Add or update Wiki property",
			editorCallback: (editor, _view) =>
				new PropertyModal(this.app, editor).open(),
		})

		this.addCommand({
			id: "add-block",
			name: "Add a Block",
			editorCallback: (editor, _view) =>
				new BlockModal(this.app, editor).open(),
		})

		// Get a list of registered users
		this.addCommand({
			id: "get-user-list",
			name: "Get list of registered users",
			callback: async () => {
				const users = await getUsersFromRemote(
					settings.dbUrl,
					settings.dbToken
				)
				new UserListModal(this.app, users).open()
			},
		})

		this.addCommand({
			id: "ping-deploy-hook",
			name: "Redeploy website",
			callback: async () => await pingDeployHook(settings),
		})

		this.addSettingTab(new WikiGeneratorSettingTab(this.app, this))
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		)
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}
}
