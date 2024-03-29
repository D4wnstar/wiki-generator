import { SupabaseClient } from "@supabase/supabase-js"
import { Notice, Plugin, TFolder, Vault } from "obsidian"
import { massAddPublish, massSetPublishState, uploadNotes } from "src/commands"
import { uploadConfig } from "src/config"
import { Database } from "src/database/database.types"
import { initializeDatabase } from "src/database/init"
import { autopublishNotes } from "src/events"
import { checkForTemplateUpdates } from "src/repository"
import {
	DEFAULT_SETTINGS,
	WikiGeneratorSettingTab,
	WikiGeneratorSettings,
	addFolderContextMenu,
} from "src/settings"
import { createClientWrapper, getProfiles } from "src/database/requests"
import { PropertyModal, UserListModal } from "src/modals"

/**
 * A global reference to the vault to avoid having to pass it down the whole call stack.
 */
export let globalVault: Vault

/**
 * A global reference to the Supabase client to avoid having to pass it down the whole call stack.
 */
export let supabase: SupabaseClient<Database>

export default class WikiGeneratorPlugin extends Plugin {
	settings: WikiGeneratorSettings

	async onload() {
		await this.loadSettings()

		// Define shorthands for common variables
		const settings = this.settings
		const workspace = this.app.workspace

		globalVault = this.app.vault

		// Automatically initialize the database the first time the user
		// sets the database connection URL
		if (settings.firstUsage && settings.databaseUrl) {
			new Notice("Setting up the database...")
			try {
				await initializeDatabase(settings.databaseUrl)
				settings.firstUsage = false
				await this.saveSettings()
				new Notice("Database fully set up!")
			} catch (e) {
				new Notice(
					"The following error occured when initializing the database:",
					e.message
				)
				console.error(
					"The following error occured when initializing the database:",
					e.message
				)
			}
		}

		// Create the Supabase client on startup
		// Client is created on startup as there's no exposed API to remove them
		// so creating one on each uploadNotes call creates warnings about having
		// multiple GoTrueClients active at the same time, which is undefined behaviour
		try {
			supabase = createClientWrapper(settings)
		} catch (e) {
			new Notice(`Supabase Error: ${e.message}`)
		}

		// Check for website updates
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
				this.app.vault.on("create", () =>
					autopublishNotes(settings, workspace)
				)
			)
		})

		// Add context menu settings for public/private folders
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, folder) => addFolderContextMenu(settings, this, menu, folder))
		)

		this.addRibbonIcon("upload-cloud", "Upload Notes", async () => {
			await uploadNotes(settings)
		})

		this.addCommand({
			id: "upload-notes",
			name: "Upload notes",
			callback: async () => {
				await uploadNotes(settings)
			},
		})

		this.addCommand({
			id: "upload-notes-overwrite",
			name: "Upload notes and overwrite media files",
			callback: async () => {
				uploadConfig.overwriteFiles = true
				await uploadNotes(settings)
			},
		})

		this.addCommand({
			id: "mass-add-publish",
			name: "Add publish property to publishable notes",
			callback: () => massAddPublish(settings),
		})

		this.addCommand({
			id: "mass-set-publish-true",
			name: "Set publish property to true on publishable notes",
			callback: () => massSetPublishState(settings, true),
		})

		this.addCommand({
			id: "mass-set-publish-false",
			name: "Set publish property to false on publishable notes",
			callback: () => massSetPublishState(settings, false),
		})

		this.addCommand({
			id: "add-update-wiki-property",
			name: "Add or update Wiki property",
			editorCallback: (editor, _view) =>
				new PropertyModal(this.app, editor).open(),
		})

		this.addCommand({
			id: "get-user-list",
			name: "Get list of registered users",
			callback: async () =>
				new UserListModal(this.app, await getProfiles()).open(),
		})

		this.addSettingTab(new WikiGeneratorSettingTab(this.app, this))
	}

	onunload() { }

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
