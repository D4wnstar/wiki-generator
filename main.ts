import { App, Notice, Plugin, PluginSettingTab, Setting, Vault } from "obsidian"
import { uploadConfig } from "src/config"
import {
	DatabaseError,
	FrontPageError,
	convertNotesForUpload,
} from "src/format"
import { findClosestWidthClass } from "src/wikilinks"

interface WikiGeneratorSettings {
	supabaseUrl: string
	supabaseAnonKey: string
	supabaseServiceKey: string
	supabaseUseLocal: boolean
	supabaseUrlLocal: string
	supabaseAnonKeyLocal: string
	supabaseServiceKeyLocal: string
}

const DEFAULT_SETTINGS: WikiGeneratorSettings = {
	supabaseUrl: "",
	supabaseAnonKey: "",
	supabaseServiceKey: "",
	supabaseUseLocal: false,
	supabaseUrlLocal: "http://localhost:54321",
	supabaseAnonKeyLocal: "",
	supabaseServiceKeyLocal: "",
}

async function uploadNotes(
	vault: Vault,
	supabaseUrl: string,
	supabaseAnonKey: string,
	supabaseServiceKey: string
) {
	console.log("Uploading notes...")
	new Notice("Uploading notes...")
	try {
		await convertNotesForUpload(
			vault,
			supabaseUrl,
			supabaseAnonKey,
			supabaseServiceKey
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

export default class WikiGeneratorPlugin extends Plugin {
	settings: WikiGeneratorSettings

	async onload() {
		await this.loadSettings()

		this.addRibbonIcon("upload-cloud", "Upload Notes", async () => {
			await uploadNotes(
				this.app.vault,
				this.settings.supabaseUseLocal
					? "http://localhost:54321"
					: this.settings.supabaseUrl,
				this.settings.supabaseUseLocal
					? this.settings.supabaseAnonKeyLocal
					: this.settings.supabaseAnonKey,
				this.settings.supabaseUseLocal
					? this.settings.supabaseServiceKeyLocal
					: this.settings.supabaseServiceKey
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
					this.settings.supabaseUseLocal
						? "http://localhost:54321"
						: this.settings.supabaseUrl,
					this.settings.supabaseUseLocal
						? this.settings.supabaseAnonKeyLocal
						: this.settings.supabaseAnonKey,
					this.settings.supabaseUseLocal
						? this.settings.supabaseServiceKeyLocal
						: this.settings.supabaseServiceKey
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
					this.settings.supabaseUseLocal
						? "http://localhost:54321"
						: this.settings.supabaseUrl,
					this.settings.supabaseUseLocal
						? this.settings.supabaseAnonKeyLocal
						: this.settings.supabaseAnonKey,
					this.settings.supabaseUseLocal
						? this.settings.supabaseServiceKeyLocal
						: this.settings.supabaseServiceKey
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

		new Setting(containerEl).setName("Tokens").setHeading()

		new Setting(containerEl)
			.setName("Supabase URL")
			.setDesc("The URL for the Supabase API")
			.addText((text) =>
				text
					.setPlaceholder("Copy your token")
					.setValue(this.plugin.settings.supabaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.supabaseUrl = value
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl)
			.setName("Supabase Anon Key")
			.setDesc("The anon key for Supabase")
			.addText((text) =>
				text
					.setPlaceholder("Copy your token")
					.setValue(this.plugin.settings.supabaseAnonKey)
					.onChange(async (value) => {
						this.plugin.settings.supabaseAnonKey = value
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl)
			.setName("Supabase Service Key")
			.setDesc("The Service key for Supabase")
			.addText((text) =>
				text
					.setPlaceholder("Copy your token")
					.setValue(this.plugin.settings.supabaseServiceKey)
					.onChange(async (value) => {
						this.plugin.settings.supabaseServiceKey = value
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl).setName("Developer Options").setHeading()

		new Setting(containerEl)
			.setName("Use Local Supabase Docker Container")
			.setDesc(
				"Use a local Supabase container for plugin development. Requires setting the local anon and service keys below"
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
				"The URL for the API of a local Supabase instance. You probably don't need to change this"
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.supabaseUrlLocal)
					.onChange(async (value) => {
						this.plugin.settings.supabaseUrlLocal = value
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl)
			.setName("Supabase Anon Key (Local)")
			.setDesc("The anon key for a local Supabase instance")
			.addText((text) =>
				text
					.setPlaceholder("Copy your token")
					.setValue(this.plugin.settings.supabaseAnonKeyLocal)
					.onChange(async (value) => {
						this.plugin.settings.supabaseAnonKeyLocal = value
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl)
			.setName("Supabase Service Key (Local)")
			.setDesc("The Service key for a local Supabase instance")
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
