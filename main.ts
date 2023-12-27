import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian"
import { join } from "path"
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

export default class WikiGeneratorPlugin extends Plugin {
	settings: WikiGeneratorSettings

	async onload() {
		await this.loadSettings()

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon(
			"dice",
			"Upload Notes",
			async () => {
				new Notice("Beginning note conversion...")
				try {
					await convertNotesForUpload(
						this.app.vault,
						join(
							this.app.vault.adapter.basePath,
							"/.obsidian/plugins/obsidian-wiki-generator/"
						),
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
				} catch (error) {
					if (
						error instanceof FrontPageError ||
						error instanceof DatabaseError
					) {
						console.error(error.message)
						new Notice(error.message)
						return
					} else {
						throw error
					}
				}

				new Notice("Finshed uploading notes!")
			}
		)

		const testButton = this.addRibbonIcon(
			"test-tube-2",
			"Test",
			async () => {
				console.log(findClosestWidthClass(500))
			}
		)

		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: "upload-notes",
			name: "Upload notes",
			callback: async () => {
				new Notice("Beginning note conversion...")
				await convertNotesForUpload(
					this.app.vault,
					join(
						this.app.vault.adapter.basePath,
						"/.obsidian/plugins/obsidian-wiki-generator/"
					),
					this.settings.supabaseUseLocal
						? this.settings.supabaseUrl
						: "http://localhost:54321",
					this.settings.supabaseUseLocal
						? this.settings.supabaseAnonKey
						: this.settings.supabaseAnonKeyLocal,
					this.settings.supabaseUseLocal
						? this.settings.supabaseServiceKey
						: this.settings.supabaseServiceKeyLocal
				)
				new Notice("Successfully uploaded notes!")
			},
		})

		// This adds a settings tab so the user can configure various aspects of the plugin
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
