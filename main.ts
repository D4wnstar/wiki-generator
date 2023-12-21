import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian"
import { join } from "path"
import { convertNotesForUpload } from "src/format"

interface WikiGeneratorSettings {
	vercelBlobToken: string
	supabaseUrl: string
	supabaseAnonKey: string
}

const DEFAULT_SETTINGS: WikiGeneratorSettings = {
	vercelBlobToken: "",
}

export default class WikiGeneratorPlugin extends Plugin {
	settings: WikiGeneratorSettings

	async onload() {
		await this.loadSettings()

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon("dice", "Greet", async () => {
			new Notice("Beginning note conversion...")
			await convertNotesForUpload(
				this.app.vault,
				join(
					this.app.vault.adapter.basePath,
					"/.obsidian/plugins/obsidian-wiki-generator/"
				),
				this.settings.vercelBlobToken
			)
			new Notice("Successfully uploaded notes!")
		})
		// Perform additional things with the ribbon
		ribbonIconEl.addClass("my-plugin-ribbon-class")

		const testButton = this.addRibbonIcon("test-tube-2", "Test", async () => {
			console.log(this.app.vault.getFiles())
		})

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
					this.settings.vercelBlobToken
				)
				new Notice("Successfully uploaded notes!")
			},
		})

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this))
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

class SampleSettingTab extends PluginSettingTab {
	plugin: WikiGeneratorPlugin

	constructor(app: App, plugin: WikiGeneratorPlugin) {
		super(app, plugin)
		this.plugin = plugin
	}

	display(): void {
		const { containerEl } = this

		containerEl.empty()

		new Setting(containerEl)
			.setName("Vercel Blob Token")
			.setDesc(
				"Secret token for Vercel Blob file storage. You can find it in your Vercel dashboard."
			)
			.addText((text) => text
				.setPlaceholder("Copy your token")
				.setValue(this.plugin.settings.vercelBlobToken)
				.onChange(async (value) => {
					this.plugin.settings.vercelBlobToken = value
					await this.plugin.saveSettings()
				})
			)

		new Setting(containerEl)
			.setName("Supabase Anon Key")
			.setDesc("The anon key for Supabase")
			.addText((text) => text
				.setPlaceholder("Copy your token")
				.setValue(this.plugin.settings.supabaseAnonKey)
				.onChange(async (value) => {
					this.plugin.settings.supabaseAnonKey = value
					await this.plugin.saveSettings()
				})
			)

		new Setting(containerEl)
			.setName("Supabase URL")
			.setDesc("The URL for Supabase")
			.addText((text) => text
				.setPlaceholder("Copy your token")
				.setValue(this.plugin.settings.supabaseUrl)
				.onChange(async (value) => {
					this.plugin.settings.supabaseUrl = value
					await this.plugin.saveSettings()
				})
			)
	}
}
