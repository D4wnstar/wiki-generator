import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { join } from 'path';
import { convertNotesForUpload } from 'src/format';

interface WikiGenerator {
	mySetting: string;
}

const DEFAULT_SETTINGS: WikiGenerator = {
	mySetting: 'default'
}

export default class HelloWorldPlugin extends Plugin {
	settings: WikiGenerator;

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Greet', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice("hi")
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');


		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'upload-notes',
			name: 'Upload notes',
			callback: async () => {
				new Notice("Beginning note conversion...")
				await convertNotesForUpload(
					this.app.vault, join(this.app.vault.adapter.basePath, "/.obsidian/plugins/obsidian-wiki-generator/")
				)
				new Notice("Successfully uploaded notes!")
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}


class SampleSettingTab extends PluginSettingTab {
	plugin: HelloWorldPlugin;

	constructor(app: App, plugin: HelloWorldPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Setting #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
