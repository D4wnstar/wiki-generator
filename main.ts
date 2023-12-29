import { SupabaseClient, createClient } from "@supabase/supabase-js"
import { App, Notice, Plugin, PluginSettingTab, Setting, Vault } from "obsidian"
import { uploadConfig } from "src/config"
import { Database } from "src/database.types"
import {
	DatabaseError,
	FrontPageError,
	convertNotesForUpload,
} from "src/format"
import { findClosestWidthClass } from "src/wikilinks"

interface WikiGeneratorSettings {
	wikiTitle: string,
	supabaseUrl: string
	supabaseAnonKey: string
	supabaseServiceKey: string
	vercelDeployHook: string
	supabaseUseLocal: boolean
	supabaseUrlLocal: string
	supabaseAnonKeyLocal: string
	supabaseServiceKeyLocal: string
}

const DEFAULT_SETTINGS: WikiGeneratorSettings = {
	wikiTitle: "Awesome Wiki",
	supabaseUrl: "",
	supabaseAnonKey: "",
	supabaseServiceKey: "",
	vercelDeployHook: "",
	supabaseUseLocal: false,
	supabaseUrlLocal: "http://localhost:54321",
	supabaseAnonKeyLocal: "",
	supabaseServiceKeyLocal: "",
}

async function uploadNotes(
	vault: Vault,
	supabase: SupabaseClient<Database> | undefined,
	deployHookUrl: string | undefined,
	settings: WikiGeneratorSettings,
) {
	if (!supabase) {
		console.error("The Supabase client has not been initialized properly. Please check the URL and Service Key and reconnect.")
		new Notice("Cannot connect to Supabase. Please check the URL and Service Key and reconnect.")
		return
	}

	// Reset wiki settings
	const { error: deletionError } = await supabase
		.from("wiki_settings")
		.delete()
		.gte("id", 0)

	// Insert the new settings
	const { error: settingsError } = await supabase
		.from("wiki_settings")
		.insert({
			settings: {
				title: settings.wikiTitle
			}
		})

	if (deletionError || settingsError) {
		new Notice("Something went wrong when updating wiki settings.")
		if (deletionError) console.error(deletionError)
		if (settingsError) console.error(settingsError)		
		return
	}

	console.log("Uploading notes...")
	new Notice("Uploading notes...")
	try {
		await convertNotesForUpload(
			vault,
			supabase,
			deployHookUrl
		)
	} catch (error) {
		new Notice(error.message)
		if (error instanceof FrontPageError || error instanceof DatabaseError) {
			console.error(error.message)
			return
		} else {
			console.error(`Uncaught error: ${error.message}`)
			throw error
		}
	}

	console.log("Successfully uploaded notes!")
	new Notice("Finshed uploading notes!")
}

function createClientWrapper(settings: WikiGeneratorSettings) {
	let client: SupabaseClient

	if (
		settings.supabaseUseLocal &&
		settings.supabaseUrlLocal &&
		settings.supabaseServiceKeyLocal
	) {
		client = createClient(
			settings.supabaseUrlLocal,
			settings.supabaseServiceKeyLocal
		)
	} else if (
		settings.supabaseUrl &&
		settings.supabaseServiceKey
	) {
		client = createClient( 
			settings.supabaseUrl,
			settings.supabaseServiceKey
		)
	} else {
		throw new Error("Please set both the URL and Service Key for Supabase in the settings")
	}
	
	return client
}

export default class WikiGeneratorPlugin extends Plugin {
	settings: WikiGeneratorSettings

	async onload() {
		await this.loadSettings()

		// Create the Supabase client on startup
		let supabase: SupabaseClient
		try {	
			supabase = createClientWrapper(this.settings)
		} catch (e) {
			new Notice(`Supabase Error: ${e}`)
		}

		this.addRibbonIcon("upload-cloud", "Upload Notes", async () => {
			await uploadNotes(
				this.app.vault,
				supabase,
				this.settings.supabaseUseLocal
					? undefined
					: this.settings.vercelDeployHook,
				this.settings,
			)
		})

		this.addRibbonIcon("test-tube-2", "Test", async () => {
			console.log(findClosestWidthClass(500))
		})

		this.addCommand({
			id: "upload-notes",
			name: "Upload notes",
			callback: async () => {
				await uploadNotes(
					this.app.vault,
					supabase,
					this.settings.supabaseUseLocal
						? undefined
						: this.settings.vercelDeployHook,
					this.settings,
				)
			},
		})

		this.addCommand({
			id: "upload-notes-overwrite",
			name: "Upload notes and overwrite media files",
			callback: async () => {
				uploadConfig.overwriteFiles = true
				await uploadNotes(
					this.app.vault,
					supabase,
					this.settings.supabaseUseLocal
						? undefined
						: this.settings.vercelDeployHook,
					this.settings
				)
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

class WikiGeneratorSettingTab extends PluginSettingTab {
	plugin: WikiGeneratorPlugin

	constructor(app: App, plugin: WikiGeneratorPlugin) {
		super(app, plugin)
		this.plugin = plugin
	}

	display(): void {
		const { containerEl } = this

		containerEl.empty()

		new Setting(containerEl).setName("Wiki Settings").setHeading()

		new Setting(containerEl)
			.setName("Wiki Title")
			.setDesc("The title of your wiki. Will be updated next time you upload your notes.")
			.addText((text) => {
				text
					.setPlaceholder("Title goes here...")
					.setValue(this.plugin.settings.wikiTitle)
					.onChange(async (value) => {
						this.plugin.settings.wikiTitle = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl).setName("Tokens").setHeading()

		new Setting(containerEl)
			.setName("Supabase URL")
			.setDesc("The URL for the Supabase API. Changing requires a restart.")
			.addText((text) =>
				text
					.setPlaceholder("Copy your token")
					.setValue(this.plugin.settings.supabaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.supabaseUrl = value
						await this.plugin.saveSettings()
					})
			)

		// new Setting(containerEl)
		// 	.setName("Supabase Anon Key")
		// 	.setDesc("The anon key for Supabase. Changing requires a restart.")
		// 	.addText((text) =>
		// 		text
		// 			.setPlaceholder("Copy your token")
		// 			.setValue(this.plugin.settings.supabaseAnonKey)
		// 			.onChange(async (value) => {
		// 				this.plugin.settings.supabaseAnonKey = value
		// 				await this.plugin.saveSettings()
		// 			})
		// 	)

		new Setting(containerEl)
			.setName("Supabase Service Key")
			.setDesc("The Service key for Supabase. Changing requires a restart.")
			.addText((text) =>
				text
					.setPlaceholder("Copy your token")
					.setValue(this.plugin.settings.supabaseServiceKey)
					.onChange(async (value) => {
						this.plugin.settings.supabaseServiceKey = value
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl)
			.setName("Vercel Deploy Hook")
			.setDesc(
				"The URL used to update your website when you upload notes."
			)
			.addText((text) => {
				text.setPlaceholder("Copy the URL")
					.setValue(this.plugin.settings.vercelDeployHook)
					.onChange(async (value) => {
						this.plugin.settings.vercelDeployHook = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl).setName("Developer Options").setHeading()

		new Setting(containerEl)
			.setName("Use Local Supabase Docker Container")
			.setDesc(
				"Use a local Supabase container for plugin development. Requires setting the local anon and service keys below. Changing requires a restart."
			)
			.addToggle(async (toggle) => {
				toggle
					.setValue(this.plugin.settings.supabaseUseLocal)
					.onChange(async (value) => {
						this.plugin.settings.supabaseUseLocal = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("Supabase URL (Local)")
			.setDesc(
				"The URL for the API of a local Supabase instance. You probably don't need to change this. Changing requires a restart."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.supabaseUrlLocal)
					.onChange(async (value) => {
						this.plugin.settings.supabaseUrlLocal = value
						await this.plugin.saveSettings()
					})
			)

		// new Setting(containerEl)
		// 	.setName("Supabase Anon Key (Local)")
		// 	.setDesc("The anon key for a local Supabase instance. Changing requires a restart.")
		// 	.addText((text) =>
		// 		text
		// 			.setPlaceholder("Copy your token")
		// 			.setValue(this.plugin.settings.supabaseAnonKeyLocal)
		// 			.onChange(async (value) => {
		// 				this.plugin.settings.supabaseAnonKeyLocal = value
		// 				await this.plugin.saveSettings()
		// 			})
		// 	)

		new Setting(containerEl)
			.setName("Supabase Service Key (Local)")
			.setDesc("The Service key for a local Supabase instance. Changing requires a restart.")
			.addText((text) =>
				text
					.setPlaceholder("Copy your token")
					.setValue(this.plugin.settings.supabaseServiceKeyLocal)
					.onChange(async (value) => {
						this.plugin.settings.supabaseServiceKeyLocal = value
						await this.plugin.saveSettings()
					})
			)
	}
}
