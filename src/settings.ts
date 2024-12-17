import WikiGeneratorPlugin from "main"
import {
	PluginSettingTab,
	App,
	Setting,
	Notice,
	normalizePath,
	Menu,
	TAbstractFile,
	TFolder,
} from "obsidian"
import { checkForTemplateUpdates, pullWebsiteUpdates } from "./repository"

export interface WikiGeneratorSettings {
	wikiTitle: string
	allowLogins: boolean
	autopublishNotes: boolean
	restrictFolders: boolean
	publicFolders: string[]
	privateFolders: string[]
	localExport: boolean
	websiteUrl: string
	adminApiKey: string
	githubUsername: string
	githubRepoName: string
	githubRepoToken: string
	githubAutoapplyUpdates: boolean
	githubCheckUpdatesOnStartup: boolean
}

export const DEFAULT_SETTINGS: WikiGeneratorSettings = {
	wikiTitle: "Awesome Wiki",
	allowLogins: true,
	autopublishNotes: true,
	restrictFolders: false,
	publicFolders: [],
	privateFolders: [],
	localExport: false,
	websiteUrl: "",
	adminApiKey: "",
	githubUsername: "",
	githubRepoName: "",
	githubRepoToken: "",
	githubAutoapplyUpdates: true,
	githubCheckUpdatesOnStartup: false,
}

export class WikiGeneratorSettingTab extends PluginSettingTab {
	plugin: WikiGeneratorPlugin

	constructor(app: App, plugin: WikiGeneratorPlugin) {
		super(app, plugin)
		this.plugin = plugin
	}

	display(): void {
		const { containerEl } = this
		const settings = this.plugin.settings

		containerEl.empty()

		new Setting(containerEl).setName("Vault").setHeading()

		new Setting(containerEl)
			.setName("Autopublish new notes")
			.setDesc(
				"Automatically add the 'wiki-publish' property to new notes. Can be restricted."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(settings.autopublishNotes)
					.onChange(async (value) => {
						settings.autopublishNotes = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("Restrict folders")
			.setDesc(
				"Restrict publishing-related commands to work only within these folders. Set the folders below."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(settings.restrictFolders)
					.onChange(async (value) => {
						settings.restrictFolders = value
						await this.plugin.saveSettings()
					})
			})

		const folderDesc = document.createDocumentFragment()
		folderDesc.append(
			"Set folders to publish notes from. Commands and settings that automatically set publish state, such as the above 'Autopublish new notes', will only apply to notes created and present in these folders. Note that the 'wiki-publish' property has the final say on whether the note gets published or not, regardless of what folder it's in.",
			folderDesc.createEl("br"),
			folderDesc.createEl("br"),
			"You must provide the full path to the folder, separated by forward slashes. For example:",
			folderDesc.createEl("br"),
			folderDesc.createEl("code", {
				text: "University/Course Notes/Stellar Evolution",
			}),
			folderDesc.createEl("br"),
			folderDesc.createEl("strong", { text: "Hot Tip:" }),
			" If you right click on a folder, you'll see two options to add it here automatically."
		)
		new Setting(containerEl)
			.setName("Public folders")
			.setDesc(folderDesc)
			.addButton((button) => {
				button
					.setButtonText("Add folder")
					.setCta()
					.onClick(async () => {
						settings.publicFolders.push("")
						await this.plugin.saveSettings()
						this.display()
					})
			})

		settings.publicFolders.forEach((folder, index) => {
			new Setting(containerEl)
				.addText((text) => {
					text.setPlaceholder("Add folder...")
						.setValue(folder)
						.onChange(async (newFolder) => {
							newFolder = normalizePath(newFolder)
							settings.publicFolders[index] = newFolder
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
							settings.publicFolders.splice(index, 1)
							await this.plugin.saveSettings()
							this.display()
						})
				})
		})

		new Setting(containerEl)
			.setName("Private folders")
			.setDesc(
				'Set folders to NOT publish notes from. Works exactly as above, but in reverse. Use this as a way to filter out some things from public folders, as in "Publish everything in here, except..."'
			)
			.addButton((button) => {
				button
					.setButtonText("Add folder")
					.setCta()
					.onClick(async () => {
						settings.privateFolders.push("")
						await this.plugin.saveSettings()
						this.display()
					})
			})

		settings.privateFolders.forEach((folder, index) => {
			new Setting(containerEl)
				.addText((text) => {
					text.setPlaceholder("Add folder...")
						.setValue(folder)
						.onChange(async (newFolder) => {
							newFolder = normalizePath(newFolder)
							settings.privateFolders[index] = newFolder
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
							settings.privateFolders.splice(index, 1)
							await this.plugin.saveSettings()
							this.display()
						})
				})
		})

		new Setting(containerEl)
			.setName("Wiki")
			.setHeading()
			.setDesc(
				"These settings will be sent to the website when you upload your notes."
			)

		new Setting(containerEl)
			.setName("Wiki title")
			.setDesc(
				"The title of your wiki. Will appear at the top of the page."
			)
			.addText((text) => {
				text.setPlaceholder("Title goes here...")
					.setValue(settings.wikiTitle)
					.onChange(async (value) => {
						settings.wikiTitle = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("Allow logins?")
			.setDesc("Whether to allow your users to login or create accounts.")
			.addToggle((toggle) => {
				toggle
					.setValue(settings.allowLogins)
					.onChange(async (value) => {
						settings.allowLogins = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl).setName("Website").setHeading()

		new Setting(containerEl)
			.setName("Website URL")
			.setDesc("The URL of your website (including the leading https).")
			.addText((text) =>
				text
					.setPlaceholder("https://www.your-website-here.com")
					.setValue(settings.websiteUrl)
					.onChange(async (value) => {
						// Remove trailing slashes
						settings.websiteUrl = value.replace(/\/$/, "")
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl)
			.setName("Admin API key")
			.setDesc(
				"An API key that gives access to website user accounts from Obsidian. Do not share this."
			)
			.addText((text) =>
				text
					.setPlaceholder(
						settings.adminApiKey === ""
							? "Copy your key"
							: "Key saved!"
					)
					.onChange(async (value) => {
						settings.adminApiKey = value
						await this.plugin.saveSettings()
					})
			)

		new Setting(containerEl)
			.setName("Check for website updates")
			.setDesc(
				"Check if your website's template has any updates. By default this check is also done every time you start Obsidian."
			)
			.addButton((button) => {
				button
					.setButtonText("Check for updates")
					.setCta()
					.onClick(async () => {
						const updates = await checkForTemplateUpdates(
							settings.githubUsername,
							settings.githubRepoName,
							undefined,
							settings.githubRepoToken
						)
						if (!updates) {
							new Notice("Your website is already up to date!")
						} else {
							new Notice(
								"There is an update available for your website. Update it from the settings tab."
							)
						}
					})
			})

		new Setting(containerEl)
			.setName("Check for updates on startup")
			.setDesc(
				"Automatically check for website updates every time you start Obsidian. This will prevent you from opening this vault if you have no internet connection."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(settings.githubCheckUpdatesOnStartup)
					.onChange(async (value) => {
						settings.githubCheckUpdatesOnStartup = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("Update website repository")
			.setDesc(
				"Update your website to synchronize with all new template additions. This may take some time. Please don't close Obsidian while updating. Make sure you also update this plugin whenever you update your website to avoid inconsistencies."
			)
			.addButton((button) => {
				button
					.setButtonText("Update website")
					.setCta()
					.onClick(async () => {
						if (
							settings.githubRepoToken &&
							settings.githubUsername &&
							settings.githubRepoName
						) {
							new Notice("Updating your website...")
							const prUrl = await pullWebsiteUpdates(
								settings.githubRepoToken,
								settings.githubUsername,
								settings.githubRepoName,
								settings.githubAutoapplyUpdates
							)
							if (prUrl) {
								new Notice(
									"A new pull request has been opened in your website's repository. You must merge it for the update to apply."
								)
							} else {
								new Notice("Your website is now up to date.")
							}
						} else {
							new Notice(
								"Please set your GitHub username, repository and token."
							)
						}
					})
			})

		const autoapplyUpdateDesc = document.createDocumentFragment()
		autoapplyUpdateDesc.append(
			"If true, will apply updates to your code as soon as you click the 'Update website' button. ",
			folderDesc.createEl("strong", { text: "THIS IS IRREVERSIBLE." }),
			" If you never touched your website's code directly, this can stay on.",
			" If you made any commits to your repository, set this to false or it will overwrite your changes.",
			" If false, updating will create a new branch and update files there.",
			" It'll then create a pull request to merge into the main branch so you can pick and choose updates and solve merge conflicts."
		)
		new Setting(containerEl)
			.setName("Apply website updates automatically")
			.setDesc(autoapplyUpdateDesc)
			.addToggle((toggle) => {
				toggle
					.setValue(settings.githubAutoapplyUpdates)
					.onChange(async (value) => {
						settings.githubAutoapplyUpdates = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl).setName("GitHub").setHeading()

		new Setting(containerEl)
			.setName("GitHub username")
			.setDesc("Your GitHub username.")
			.addText((text) => {
				text.setPlaceholder("Copy your username")
					.setValue(settings.githubUsername)
					.onChange(async (value) => {
						settings.githubUsername = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("GitHub repository name")
			.setDesc("The name of your website's repository.")
			.addText((text) => {
				text.setPlaceholder("Copy the name")
					.setValue(settings.githubRepoName)
					.onChange(async (value) => {
						settings.githubRepoName = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("GitHub repository token")
			.setDesc(
				"The token required to access your website's GitHub repository."
			)
			.addText((text) => {
				text.setPlaceholder(
					settings.githubRepoToken === ""
						? "Copy your token"
						: "Key saved!"
				).onChange(async (value) => {
					settings.githubRepoToken = value
					await this.plugin.saveSettings()
				})
			})

		new Setting(containerEl).setName("Developer").setHeading()

		new Setting(containerEl)
			.setName("Local export")
			.setDesc(
				"Export the database to a local SQLite file instead of pushing it to GitHub. Useful for testing or if you need to manually interact with the database."
			)
			.addToggle(async (toggle) => {
				toggle
					.setValue(settings.localExport)
					.onChange(async (value) => {
						settings.localExport = value
						await this.plugin.saveSettings()
					})
			})
	}
}

export function addFolderContextMenu(
	settings: WikiGeneratorSettings,
	plugin: WikiGeneratorPlugin,
	menu: Menu,
	folder: TAbstractFile
) {
	if (folder instanceof TFolder) {
		menu.addSeparator()

		menu.addItem((item) => {
			item.setTitle("Add to public folders")
				.setIcon("eye")
				.onClick(async () => {
					settings.publicFolders.push(folder.path)
					await plugin.saveSettings()
					new Notice(`Added ${folder.path} to public folders`)
				})
		})

		menu.addItem((item) => {
			item.setTitle("Add to private folders")
				.setIcon("eye-off")
				.onClick(async () => {
					settings.privateFolders.push(folder.path)
					await plugin.saveSettings()
					new Notice(`Added ${folder.path} to private folders`)
				})
		})
	}
}
