import WikiGeneratorPlugin from "main"
import { PluginSettingTab, App, Setting, Notice } from "obsidian"
import { resetDatabase } from "./database/init"
import { checkForTemplateUpdates, updateUserRepository } from "./repository"

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
	githubUsername: string
	githubRepoName: string
	githubRepoToken: string
	githubAutoapplyUpdates: boolean
	supabaseUseLocal: boolean
	databaseUrlLocal: string
	supabaseApiUrlLocal: string
	supabaseAnonKeyLocal: string
	supabaseServiceKeyLocal: string
}

export const DEFAULT_SETTINGS: WikiGeneratorSettings = {
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
	githubUsername: "",
	githubRepoName: "",
	githubRepoToken: "",
	githubAutoapplyUpdates: true,
	supabaseUseLocal: false,
	databaseUrlLocal: "postgresql://postgres:postgres@localhost:54322/postgres",
	supabaseApiUrlLocal: "http://localhost:54321",
	supabaseAnonKeyLocal: "",
	supabaseServiceKeyLocal: "",
}

export class WikiGeneratorSettingTab extends PluginSettingTab {
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
			.setDesc("Automatically add the 'wiki-publish' property to new notes. Can be restricted.")
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
				"Restrict publishing-related commands to work only within these folders. Set the folders below."
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
		
		new Setting(containerEl).setName("GitHub").setHeading()
		
		new Setting(containerEl)
			.setName("GitHub Username")
			.setDesc("Your GitHub username.")
			.addText((text) => {
				text.setPlaceholder("Copy your username")
				.setValue(this.plugin.settings.githubUsername)
				.onChange(async (value) => {
					this.plugin.settings.githubUsername = value
					await this.plugin.saveSettings()
				})
			})

		new Setting(containerEl)
			.setName("GitHub Repository Name")
			.setDesc("The name of your website's repository.")
			.addText((text) => {
				text.setPlaceholder("Copy the name")
				.setValue(this.plugin.settings.githubRepoName)
				.onChange(async (value) => {
					this.plugin.settings.githubRepoName = value
					await this.plugin.saveSettings()
				})
			})

		new Setting(containerEl)
			.setName("GitHub Repository Token")
			.setDesc("The token required to access your website's GitHub repository.")
			.addText((text) => {
				text.setPlaceholder("Copy the token")
				.setValue(this.plugin.settings.githubRepoToken)
				.onChange(async (value) => {
					this.plugin.settings.githubRepoToken = value
					await this.plugin.saveSettings()
				})
			})

		new Setting(containerEl)
			.setName("Check For Website Updates")
			.setDesc("Check if your website's template has any updates. By default this check is also done every time you start Obsidian.")
			.addButton((button) => {
				button
					.setButtonText("Check for updates")
					.setCta()
					.onClick(async () => {
						const updates = await checkForTemplateUpdates(
							this.plugin.settings.githubUsername,
							this.plugin.settings.githubRepoName,
							undefined,
							this.plugin.settings.githubRepoToken,
						)
						if (!updates) {
							new Notice("Your website is already up to date!")
						} else {
							new Notice("There is an update available for your website. Update it from the settings tab.")
						}
					})
			})
		
		new Setting(containerEl)
			.setName("Update Website Repository")
			.setDesc("Update your website to synchronize with all new template additions. This may take some time. Please don't close Obsidian while updating.")
			.addButton((button) => {
				button
					.setButtonText("Update website")
					.setCta()
					.onClick(async () => {
						new Notice("Updating your website...")
						const prUrl = await updateUserRepository(
							this.plugin.settings.githubRepoToken,
							this.plugin.settings.githubUsername,
							this.plugin.settings.githubRepoName,
							this.plugin.settings.githubAutoapplyUpdates,
						)
						if (prUrl) {
							new Notice("A new pull request has been opened in your website's repository. You must merge it for the update to apply.")
						}
					})
			})

		const autoapplyUpdateDesc = document.createDocumentFragment()
			autoapplyUpdateDesc.append(
				"If true, will apply updates to your code as soon as you click the Update Website button. ",
				folderDesc.createEl("strong", { text: "THIS IS IRREVERSIBLE." }),
				" If you never touched your website's code directly, this can stay on.",
				" If you made any commits to your repository, set this to false or it will overwrite your changes.",
				" If false, updating will create a new branch and update files there.",
				" It'll then create a pull request to merge into the main branch so you can pick and choose updates and solve merge conflicts."
			)
			new Setting(containerEl)
				.setName("Apply Website Updates Automatically")
				.setDesc(autoapplyUpdateDesc)
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.githubAutoapplyUpdates)
					.onChange(async (value) => {
						this.plugin.settings.githubAutoapplyUpdates = value
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
			.setDesc(
				"Reset the database to its initial state. All of your notes will be deleted from Supabase, but media files and user profiles will remain untouched. You can restore your notes by uploading them again."
			)
			.addButton((button) => {
				button
					.setButtonText("Reset database")
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
							new Notice(
								`There was an error when resetting: ${e.message}`
							)
							console.error(e.message)
						}
					})
			})
	}
}
