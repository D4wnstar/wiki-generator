import { SupabaseClient } from "@supabase/supabase-js"
import {
	App,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	Vault,
} from "obsidian"
import { uploadConfig } from "src/config"
import { Database } from "src/database/database.types"
import { initializeDatabase, resetDatabase } from "src/database/init"
import {
	DatabaseError,
	FrontPageError,
	convertNotesForUpload,
} from "src/format"
import { createClientWrapper, getPublishableFiles } from "src/utils"

export interface WikiGeneratorSettings {
	firstUsage: boolean
	wikiTitle: string
	autopublishNotes: boolean
	restrictFolders: boolean
	publishedFolders: string[]
	databaseUrl: string
	supabaseApiUrl: string
	supabaseAnonKey: string
	supabaseServiceKey: string
	vercelDeployHook: string
	supabaseUseLocal: boolean
	databaseUrlLocal: string
	supabaseApiUrlLocal: string
	supabaseAnonKeyLocal: string
	supabaseServiceKeyLocal: string
}

const DEFAULT_SETTINGS: WikiGeneratorSettings = {
	firstUsage: true,
	wikiTitle: "Awesome Wiki",
	autopublishNotes: true,
	restrictFolders: false,
	publishedFolders: [],
	databaseUrl: "",
	supabaseApiUrl: "",
	supabaseAnonKey: "",
	supabaseServiceKey: "",
	vercelDeployHook: "",
	supabaseUseLocal: false,
	databaseUrlLocal: "postgresql://postgres:postgres@localhost:54322/postgres",
	supabaseApiUrlLocal: "http://localhost:54321",
	supabaseAnonKeyLocal: "",
	supabaseServiceKeyLocal: "",
}

async function uploadNotes(
	vault: Vault,
	supabase: SupabaseClient<Database> | undefined,
	deployHookUrl: string | undefined,
	settings: WikiGeneratorSettings
) {
	if (!supabase) {
		console.error(
			"The Supabase client has not been initialized properly. Please check the URL and Service Key and reconnect."
		)
		new Notice(
			"Cannot connect to Supabase. Please check the URL and Service Key and reconnect."
		)
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
				title: settings.wikiTitle,
			},
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
		await convertNotesForUpload(vault, supabase, deployHookUrl)
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

		// Automatically initialize the database the first time the user
		// sets the database connection URL
		if (this.settings.firstUsage && this.settings.databaseUrl) {
			initializeDatabase(this.settings.databaseUrl)
			this.settings.firstUsage = false
			await this.saveSettings()
		}

		// Automatically add the dg-publish: true property on file creation
		// if the user allows it in the settings
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", () => {
					// Timeout is here to let the workspace update before getting the view
					// Half a second seems to make it play well enough with Templater
					setTimeout(() => {
						const s = this.settings
						const view =
							this.app.workspace.getActiveViewOfType(MarkdownView)
						if (s.autopublishNotes && view) {
							const fileFolder =
								view.file?.path.match(/.*(?=\/)/)?.[0]
							if (
								s.restrictFolders ||
								(fileFolder &&
									s.publishedFolders.some((path) =>
										fileFolder.includes(path)
									))
							) {
								view.editor.replaceRange(
									"---\nwg-publish: true\n---\n",
									view.editor.getCursor()
								)
							}
						}
					}, 500)
				})
			)
		})

		// Create the Supabase client on startup
		// Client is created on startup as there's no exposed API to remove them
		// so creating one on each uploadNotes call creates warnings about having
		// multiple GoTrueClients active at the same time, which is undefined behaviour
		let supabase: SupabaseClient
		try {
			supabase = createClientWrapper(this.settings)
		} catch (e) {
			new Notice(`Supabase Error: ${e.message}`)
		}

		this.addRibbonIcon("upload-cloud", "Upload Notes", async () => {
			await uploadNotes(
				this.app.vault,
				supabase,
				this.settings.supabaseUseLocal
					? undefined
					: this.settings.vercelDeployHook,
				this.settings
			)
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
					this.settings
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

		this.addCommand({
			id: "mass-add-publish",
			name: "Add publish property to all notes",
			callback: () => {
				const vault = this.app.vault
				const notes = getPublishableFiles(vault, this.settings)
				for (const note of notes) {
					vault.process(note, (noteText) => {
						const propsRegex = /^---\n(.*?)\n---/s
						const props = noteText.match(propsRegex)
						if (props) {
							const publish = props[1].match(
								/(w|d)g-publish: (true)|(false)/
							)
							if (publish) return noteText
							noteText = noteText.replace(
								propsRegex,
								`---\nwg-publish: false\n$1\n---`
							)
						} else {
							noteText =
								`---\nwg-publish: false\n---\n` + noteText
						}

						return noteText
					})
				}
			},
		})

		this.addCommand({
			id: "mass-set-publish-true",
			name: "Set publish property to true on all notes",
			callback: () => {
				const vault = this.app.vault
				const notes = getPublishableFiles(vault, this.settings)
				for (const note of notes) {
					vault.process(note, (noteText) => {
						return noteText.replace(
							/^---\n(.*?)(w|d)g-publish: false(.*?)\n---/s,
							"---\n$1$2g-publish: true$3\n---"
						)
					})
				}
			},
		})

		this.addCommand({
			id: "mass-set-publish-false",
			name: "Set publish property to false on all notes",
			callback: () => {
				const vault = this.app.vault
				const notes = getPublishableFiles(vault, this.settings)
				for (const note of notes) {
					vault.process(note, (noteText) => {
						return noteText.replace(
							/^---\n(.*?)(w|d)g-publish: true(.*?)\n---/s,
							"---\n$1$2g-publish: false$3\n---"
						)
					})
				}
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

		new Setting(containerEl).setName("Vault Settings").setHeading()

		new Setting(containerEl)
			.setName("Autopublish New Notes")
			.setDesc("Automatically set up newly created notes for publishing.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.autopublishNotes)
					.onChange(async (value) => {
						this.plugin.settings.autopublishNotes = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("Restrict Folders")
			.setDesc(
				"Only publish notes within these folders. Set the folders below."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.restrictFolders)
					.onChange(async (value) => {
						this.plugin.settings.restrictFolders = value
						await this.plugin.saveSettings()
					})
			})

		const folderDesc = document.createDocumentFragment()
		folderDesc.append(
			"Set folders to publish notes from. Commands and settings that automatically set publish state, such as the above Autopublish New Notes, will only apply to notes created and present in these folders.",
			folderDesc.createEl("br"),
			"You must provide the full path to the folder, separated by forward slashes. For example:",
			folderDesc.createEl("br"),
			"University/Course Notes/Stellar Evolution",
			folderDesc.createEl("br"),
			folderDesc.createEl("strong", { text: "Hot Tip:" }),
			' If you right click on a folder and press "Search in Folder", you can copy and paste the search parameter it gives you after path: (without the quotes!) and use it here.'
		)
		new Setting(containerEl)
			.setName("Folders To Publish")
			.setDesc(folderDesc)
			.addButton((button) => {
				button
					.setButtonText("Add folder")
					.setCta()
					.onClick(async () => {
						this.plugin.settings.publishedFolders.push("")
						await this.plugin.saveSettings()
						this.display()
					})
			})

		this.plugin.settings.publishedFolders.forEach((folder, index) => {
			new Setting(containerEl)
				.addText((text) => {
					text.setPlaceholder("Add folder...")
						.setValue(folder)
						.onChange(async (newFolder) => {
							newFolder = newFolder.replace(/\/$/, "")
							this.plugin.settings.publishedFolders[index] =
								newFolder
							await this.plugin.saveSettings()
						})

					const parentDiv = text.inputEl.parentElement
					if (parentDiv) parentDiv.style.width = "100%"
					text.inputEl.style.width = "100%"
				})
				.addExtraButton((button) => {
					button
						.setIcon("x")
						.setTooltip("Remove folder")
						.onClick(async () => {
							this.plugin.settings.publishedFolders.splice(
								index,
								1
							)
							await this.plugin.saveSettings()
							this.display()
						})
				})
		})

		new Setting(containerEl).setName("Wiki Settings").setHeading()

		new Setting(containerEl)
			.setName("Wiki Title")
			.setDesc(
				"The title of your wiki. Will be updated next time you upload your notes."
			)
			.addText((text) => {
				text.setPlaceholder("Title goes here...")
					.setValue(this.plugin.settings.wikiTitle)
					.onChange(async (value) => {
						this.plugin.settings.wikiTitle = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl).setName("Tokens").setHeading()

		new Setting(containerEl)
			.setName("Database URL")
			.setDesc(
				"The URL for the Database connection. Changing requires a restart."
			)
			.addText((text) =>
				text
					.setPlaceholder("Copy the URL")
					.setValue(this.plugin.settings.databaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.databaseUrl = value
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl)
			.setName("Supabase API URL")
			.setDesc(
				"The URL for the Supabase API. Changing requires a restart."
			)
			.addText((text) =>
				text
					.setPlaceholder("Copy the URL")
					.setValue(this.plugin.settings.supabaseApiUrl)
					.onChange(async (value) => {
						this.plugin.settings.supabaseApiUrl = value
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
			.setDesc(
				"The service key for Supabase. Changing requires a restart."
			)
			.addText((text) =>
				text
					.setPlaceholder("Copy your key")
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
				"Use a local Supabase container for plugin development. Requires setting the local service key below. Changing requires a restart."
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
			.setName("Database URL (Local)")
			.setDesc(
				"The URL for the Database connection of a local Supabase instance. You probably don't need to change this. Changing requires a restart."
			)
			.addText((text) =>
				text
					.setPlaceholder("Copy the URL")
					.setValue(this.plugin.settings.databaseUrlLocal)
					.onChange(async (value) => {
						this.plugin.settings.databaseUrlLocal = value
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl)
			.setName("Supabase API URL (Local)")
			.setDesc(
				"The URL for the API of a local Supabase instance. You probably don't need to change this. Changing requires a restart."
			)
			.addText((text) =>
				text
					.setPlaceholder("Copy the URL")
					.setValue(this.plugin.settings.supabaseApiUrlLocal)
					.onChange(async (value) => {
						this.plugin.settings.supabaseApiUrlLocal = value
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
			.setDesc(
				"The service key for a local Supabase instance. Changing requires a restart."
			)
			.addText((text) =>
				text
					.setPlaceholder("Copy your key")
					.setValue(this.plugin.settings.supabaseServiceKeyLocal)
					.onChange(async (value) => {
						this.plugin.settings.supabaseServiceKeyLocal = value
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl)
			.setName("Reset Database")
			.setDesc("Reset the database to its initial state. All of your notes will be deleted from Supabase, but your media files will remain untouched. You can restore your notes by uploading them again.")
			.addButton((button) => {
				button
					.setButtonText("Reset database")
					.setCta()
					.onClick(async () => {
						new Notice("Resetting database...")
						try {
							await resetDatabase(
								this.plugin.settings.supabaseUseLocal
								? this.plugin.settings.databaseUrlLocal
								: this.plugin.settings.databaseUrl
							)
							new Notice("Database successfully reset")
						} catch (e) {
							new Notice(`There was an error when resetting: ${e.message}`)
							console.error(e.message)
						}
					})
			})
	}
}
