import { Notice, Plugin, TFile, TFolder } from "obsidian"
import { massAddPublish, massSetPublishState, uploadNotes } from "src/commands"
import { addWikiPublishToNewFile } from "src/events"
import { checkForTemplateUpdates } from "src/repository"
import {
	DEFAULT_SETTINGS,
	WikiGeneratorSettingTab,
	WikiGeneratorSettings,
	addFolderContextMenu,
} from "src/settings"
import { getUsers } from "src/database/requests"
import { PropertyModal, UserListModal } from "src/modals"

export default class WikiGeneratorPlugin extends Plugin {
	settings: WikiGeneratorSettings

	async onload() {
		await this.loadSettings()

		// Define shorthands for common variables
		const settings = this.settings
		const workspace = this.app.workspace

		// Check for website updates on startup
		if (
			settings.githubUsername &&
			settings.githubRepoName &&
			settings.githubRepoToken &&
			settings.githubCheckUpdatesOnStartup
		) {
			const websiteUpdates = await checkForTemplateUpdates(
				settings.githubUsername,
				settings.githubRepoName,
				undefined,
				settings.githubRepoToken
			)
			if (websiteUpdates)
				new Notice(
					"There is an update available for your website. Update it from the settings tab."
				)
		}

		// Automatically add the wiki-publish: true property on file creation
		// if the user allows it in the settings
		workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					// Ignore folders being created or if this feature is disabled
					if (file instanceof TFolder || !settings.autopublishNotes) {
						return
					}
					addWikiPublishToNewFile(file as TFile, settings, workspace)
				})
			)
		})

		// Add context menu settings for public/private folders
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, folder) =>
				addFolderContextMenu(settings, this, menu, folder)
			)
		)

		// Add a ribbon icon to upload notes
		this.addRibbonIcon("cloud-upload", "Upload notes", async () => {
			try {
				await uploadNotes(this.app.vault, settings)
			} catch (error) {
				console.error("An error occured while uploading notes.", error)
				new Notice(
					`An error occured while uploading notes. ${error}`,
					0
				)
			}
		})

		// And a command for the same thing
		this.addCommand({
			id: "upload-notes",
			name: "Upload notes",
			callback: async () => {
				// uploadConfig.overwriteFiles = false
				await uploadNotes(this.app.vault, settings)
			},
		})

		// this.addCommand({
		// 	id: "upload-notes-overwrite",
		// 	name: "Upload notes and overwrite media files",
		// 	callback: async () => {
		// 		uploadConfig.overwriteFiles = true
		// 		await uploadNotes(settings)
		// 	},
		// })

		// Commands to make setting properties easier
		this.addCommand({
			id: "mass-add-publish",
			name: "Add publish property to publishable notes",
			callback: () => massAddPublish(true, settings, this.app.vault),
		})

		this.addCommand({
			id: "mass-set-publish-true",
			name: "Set publish property to true on publishable notes",
			callback: () => massSetPublishState(true, settings, this.app.vault),
		})

		this.addCommand({
			id: "mass-set-publish-false",
			name: "Set publish property to false on publishable notes",
			callback: () =>
				massSetPublishState(false, settings, this.app.vault),
		})

		this.addCommand({
			id: "add-update-wiki-property",
			name: "Add or update Wiki property",
			editorCallback: (editor, _view) =>
				new PropertyModal(this.app, editor).open(),
		})

		// Get a list of registered users
		this.addCommand({
			id: "get-user-list",
			name: "Get list of registered users",
			callback: async () => {
				const users = await getUsers(settings)
				console.log(users)
				new UserListModal(this.app, users).open()
			},
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
