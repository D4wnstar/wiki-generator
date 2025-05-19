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
import { pullWebsiteUpdates } from "./repository"
import { resetDatabase } from "./commands"
import { isWebsiteUpToDate } from "./utils"

export interface WikiGeneratorSettings {
	firstUpload: boolean
	wikiTitle: string
	allowLogins: boolean
	autopublishNotes: boolean
	restrictFolders: boolean
	publicFolders: string[]
	privateFolders: string[]
	localExport: boolean
	cloneRemoteUsers: boolean
	githubUsername: string
	githubRepoName: string
	githubRepoToken: string
	githubAutoapplyUpdates: boolean
	githubCheckUpdatesOnStartup: boolean
	/**
	 * Must be ISO 8601 format
	 */
	lastTemplateUpdate: string
	deployHook: string
	deployOnSync: boolean
	dbUrl: string
	dbToken: string
}

export const DEFAULT_SETTINGS: WikiGeneratorSettings = {
	firstUpload: true,
	wikiTitle: "Awesome Wiki",
	allowLogins: false,
	autopublishNotes: true,
	restrictFolders: false,
	publicFolders: [],
	privateFolders: [],
	localExport: false,
	cloneRemoteUsers: false,
	githubUsername: "",
	githubRepoName: "",
	githubRepoToken: "",
	githubAutoapplyUpdates: true,
	githubCheckUpdatesOnStartup: false,
	lastTemplateUpdate: "",
	dbUrl: "",
	dbToken: "",
	deployHook: "",
	deployOnSync: true,
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

		new Setting(containerEl)
			.setName("Vault")
			.setHeading()
			.setDesc("These settings change your experience here in Obsidian.")

		new Setting(containerEl)
			.setName("Add wiki-publish to new notes")
			.setDesc(
				"Automatically add the 'wiki-publish' property to new notes. Restricted."
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
				`Apply folder restrictions. Set the folders below. Any command or setting marked as 'restricted' will respect these. For example, if you use the "Add wiki-publish to everything (restricted)" command, by default every note in your vault will have the wiki-publish property added to it. However, if this setting is on and you have a single folder called "Recipes" set as public, only notes inside of "Recipes" will have wiki-publish added to them.`
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
			"Restricted commands and settings will only access files from these folders. Anything outside will be ignored. Very useful if you only want a part of your vault to be published. No public folders means your entire vault is public. Note that this has no bearing on which notes are synced: that is exclusively determined by the value of 'wiki-publish'. This is only used for commands with the 'restricted' identifier.",
			folderDesc.createEl("p", {
				text: "You must provide the full path to the folder, separated by forward slashes. For example:",
			}),
			folderDesc.createEl("code", {
				text: "University/Course Notes/Stellar Evolution",
			}),
			folderDesc.createEl("p", {
				text: "You can also add a folder by right clicking it in the file browser. Remember to update these anytime your rename your folders!",
			})
		)
		new Setting(containerEl)
			.setName("Public folders")
			.setDesc(folderDesc)
			.addButton((button) => {
				button.setButtonText("Add folder").onClick(async () => {
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
				"Like public folders, but in reverse. Anything in a private folder will be ignored by restricted commands and settings. Useful if you want to publish everything in your vault except notes from a few folders, or if you want to remove a subfolder from a public folder."
			)
			.addButton((button) => {
				button.setButtonText("Add folder").onClick(async () => {
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
				"These settings affect the look and functionality of your wiki. They will be synced alongside your notes."
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

		new Setting(containerEl)
			.setName("Website")
			.setHeading()
			.setDesc("These settings allow you to control your website.")

		new Setting(containerEl)
			.setName("Check for website updates")
			.setDesc(
				"Check if your website's template has any updates. By default this check is also done every time you start Obsidian."
			)
			.addButton((button) => {
				button
					.setButtonText("Check for updates")
					.onClick(async () => await isWebsiteUpToDate(settings))
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
				"Update your website to synchronize with all new template additions. This may take some time. Please don't close Obsidian while updating. Always update this plugin when you update the website, otherwise it might break."
			)
			.addButton((button) => {
				button.setButtonText("Update website").onClick(async () => {
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

						const now = new Date()
						settings.lastTemplateUpdate = now.toISOString()
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

		new Setting(containerEl)
			.setName("Deploy hook")
			.setDesc(
				"The link to use to tell the website to update. Create one in your Vercel settings."
			)
			.addText((text) => {
				text.setPlaceholder("Copy the URL")
					.setValue(settings.deployHook)
					.onChange(async (value) => {
						settings.deployHook = value
						// If the user is setting up a deploy hook, that means they set up the website
						// so initialize last updated state if unset
						if (settings.lastTemplateUpdate === "") {
							const now = new Date()
							settings.lastTemplateUpdate = now.toISOString()
						}
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("Database")
			.setHeading()
			.setDesc(
				"These settings affect your database, which is where your notes, files, settings and users will be stored."
			)

		new Setting(containerEl)
			.setName("Database URL")
			.setDesc("Your Turso database URL.")
			.addText((text) => {
				text.setPlaceholder("Copy your URL")
					.setValue(settings.dbUrl)
					.onChange(async (value) => {
						settings.dbUrl = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("Database Token")
			.setDesc("Your Turso database token. Do not share this.")
			.addText((text) => {
				text.setPlaceholder(
					settings.dbToken === "" ? "Copy your token" : "Token saved!"
				).onChange(async (value) => {
					settings.dbToken = value
					await this.plugin.saveSettings()
				})
			})

		new Setting(containerEl)
			.setName("Clear database")
			.setDesc(
				"Clear the contents of the database, excluding user accounts. Useful for troubleshooting and to initialize the database the first time."
			)
			.addButton((button) => {
				button
					.setButtonText("Clear database")
					.onClick(() => resetDatabase(settings, this.app.vault))
			})

		new Setting(containerEl)
			.setName("GitHub")
			.setHeading()
			.setDesc(
				"These settings affect your GitHub repository, which is where your website's code is stored."
			)

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
				"The token required to access your website's GitHub repository. Do not share this."
			)
			.addText((text) => {
				text.setPlaceholder(
					settings.githubRepoToken === ""
						? "Copy your token"
						: "Token saved!"
				).onChange(async (value) => {
					settings.githubRepoToken = value
					await this.plugin.saveSettings()
				})
			})

		new Setting(containerEl)
			.setName("Developer")
			.setHeading()
			.setDesc(
				"These settings are used for the development of this plugin, but you may find them useful if you want to run a local database instead of using Turso."
			)

		new Setting(containerEl)
			.setName("Local export")
			.setDesc(
				"Export your notes to a local SQLite file instead of pushing to Turso. Useful for testing or if you need to manually interact with the database. The database will be exported to this plugin's folder in the vault, under .obsidian/plugins/wiki-generator."
			)
			.addToggle(async (toggle) => {
				toggle
					.setValue(settings.localExport)
					.onChange(async (value) => {
						settings.localExport = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("Clone remote users")
			.setDesc(
				"When syncing notes, also clone users from the remote Turso repository to the local database. Requires having a Turso database up and running and will only take effect if exporting to a local database. Will overwrite all local users."
			)
			.addToggle(async (toggle) => {
				toggle
					.setValue(settings.cloneRemoteUsers)
					.onChange(async (value) => {
						settings.cloneRemoteUsers = value
						await this.plugin.saveSettings()
					})
			})

		new Setting(containerEl)
			.setName("Deploy on sync")
			.setDesc(
				"Whether to ping the deploy hook on a successful sync. Turning this off will prevent redeployments of the website on sync. Useful for testing the remote database without constantly redeploying. Use the 'Redeploy website' command to manually redeploy."
			)
			.addToggle(async (toggle) => {
				toggle
					.setValue(settings.deployOnSync)
					.onChange(async (value) => {
						settings.deployOnSync = value
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
