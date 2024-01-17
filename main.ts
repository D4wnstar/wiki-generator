import { SupabaseClient } from "@supabase/supabase-js"
import { Notice, Plugin } from "obsidian"
import { addWikiProperty, massAddPublish, massSetPublishState, uploadNotes } from "src/commands"
import { uploadConfig } from "src/config"
import { initializeDatabase } from "src/database/init"
import { autopublishNotes } from "src/events"
import {
	DEFAULT_SETTINGS,
	WikiGeneratorSettingTab,
	WikiGeneratorSettings,
} from "src/settings"
import { createClientWrapper } from "src/utils"

export default class WikiGeneratorPlugin extends Plugin {
	settings: WikiGeneratorSettings

	async onload() {
		await this.loadSettings()

		// Define shorthands for common variables
		const settings = this.settings
		const vault = this.app.vault
		const workspace = this.app.workspace

		// Automatically initialize the database the first time the user
		// sets the database connection URL
		if (settings.firstUsage && settings.databaseUrl) {
			new Notice("Setting up the database...")
			initializeDatabase(settings.databaseUrl)
			settings.firstUsage = false
			await this.saveSettings()
			new Notice("Database fully set up!")
		}

		// Automatically add the wiki-publish: true property on file creation
		// if the user allows it in the settings
		workspace.onLayoutReady(() => {
			this.registerEvent(
				vault.on("create", () => autopublishNotes(settings, workspace))
			)
		})

		// Create the Supabase client on startup
		// Client is created on startup as there's no exposed API to remove them
		// so creating one on each uploadNotes call creates warnings about having
		// multiple GoTrueClients active at the same time, which is undefined behaviour
		let supabase: SupabaseClient
		try {
			supabase = createClientWrapper(settings)
		} catch (e) {
			new Notice(`Supabase Error: ${e.message}`)
		}

		this.addRibbonIcon("upload-cloud", "Upload Notes", async () => {
			// await uploadNotes(vault, supabase, settings)
			const mdFiles = vault.getMarkdownFiles()
			for (const file of mdFiles) {
				vault.process(file, (data) => {
					return data.replace(/^---\n(.*?)---\n/s, "")
				})
			}
		})

		this.addCommand({
			id: "upload-notes",
			name: "Upload notes",
			callback: async () => {
				await uploadNotes(vault, supabase, settings)
			},
		})

		this.addCommand({
			id: "upload-notes-overwrite",
			name: "Upload notes and overwrite media files",
			callback: async () => {
				uploadConfig.overwriteFiles = true
				await uploadNotes(vault, supabase, settings)
			},
		})

		this.addCommand({
			id: "mass-add-publish",
			name: "Add publish property to publishable notes",
			callback: () => massAddPublish(vault, settings),
		})

		this.addCommand({
			id: "mass-set-publish-true",
			name: "Set publish property to true on publishable notes",
			callback: () => massSetPublishState(vault, settings, true),
		})

		this.addCommand({
			id: "mass-set-publish-false",
			name: "Set publish property to false on publishable notes",
			callback: () => massSetPublishState(vault, settings, false),
		})

		this.addCommand({
			id: "update-wiki-property",
			name: "Update Wiki property",
			editorCallback: (editor, view) => addWikiProperty(this.app, editor),
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
