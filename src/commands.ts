import { SupabaseClient } from "@supabase/supabase-js"
import { Vault, Notice, Editor, App, SuggestModal } from "obsidian"
import { Database } from "./database/database.types"
import { convertNotesForUpload, FrontPageError, DatabaseError } from "./format"
import { WikiGeneratorSettings } from "./settings"
import {
	getPropertiesFromEditor,
	getPublishableFiles,
	replacePropertiesFromEditor,
} from "./utils"

type Property = {
	name: string
	description: string
	valueType: string
	defaultValue: string
}

export async function uploadNotes(
	vault: Vault,
	supabase: SupabaseClient<Database> | undefined,
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

	const deployHookUrl = settings.supabaseUseLocal
		? undefined
		: settings.vercelDeployHook

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

export function massAddPublish(vault: Vault, settings: WikiGeneratorSettings) {
	const notes = getPublishableFiles(vault, settings)
	for (const note of notes) {
		vault.process(note, (noteText) => {
			const propsRegex = /^---\n(.*?)\n---/s
            // Isolate properties
			const props = noteText.match(propsRegex)
			if (props) {
                // Check if a publish propery is already there
				const publish = props[1].match(/(wiki)|(dg)-publish: (true)|(false)/)
                // If it is, leave it as is
				if (publish) return noteText
                // Otherwise add a new property, defaulting to true
				noteText = noteText.replace(
					propsRegex,
					`---\nwiki-publish: true\n$1\n---`
				)
			} else {
                // If there are no properties, prepend a new publish one
				noteText = `---\nwiki-publish: true\n---\n` + noteText
			}

			return noteText
		})
	}
}

export function massSetPublishState(
	vault: Vault,
	settings: WikiGeneratorSettings,
	state: boolean
) {
	const notes = getPublishableFiles(vault, settings)
	const regex = RegExp(`^---\n(.*?)(wiki)|(dg)-publish: ${state}(.*?)\n---`, "s")
	for (const note of notes) {
		vault.process(note, (noteText) => {
			return noteText.replace(
				regex,
				`---\n$1$2g-publish: ${state}$3\n---`
			)
		})
	}
}

const BUILTIN_PROPS: Property[] = [
	{
		name: "wiki-publish",
		description: "Defines whether the note is published or not.",
		valueType: "true/false",
		defaultValue: "true",
	},
	{
		name: "wiki-home",
		description: "Set note as the front page. Can only be set to one note.",
		valueType: "true/false",
		defaultValue: "true",
	},
    {
        name: "wiki-title",
        description: "Set your page title independently from the notes' file name.",
        valueType: "text",
        defaultValue: ""
    }
]

class PropertyModal extends SuggestModal<Property> {
	editor: Editor

	constructor(app: App, editor: Editor) {
		super(app)
		this.editor = editor
	}

	getSuggestions(query: string): Property[] | Promise<Property[]> {
		return BUILTIN_PROPS.filter((prop) =>
			prop.name.includes(query.toLocaleLowerCase())
		)
	}

	renderSuggestion(value: Property, el: HTMLElement) {
		el.createEl("div", { text: value.name })
		el.createEl("small", { text: value.description }).style.display =
			"block"
		el.createEl("small", { text: `Accepted values: ${value.valueType}` })
	}

	onChooseSuggestion(
		selectedProp: Property,
		evt: MouseEvent | KeyboardEvent
	) {
		const props = getPropertiesFromEditor(this.editor)
		props.set(selectedProp.name, selectedProp.defaultValue)
		let newProps = "---\n"
		for (const [k, v] of props.entries()) {
			newProps += `${k}: ${v}\n`
		}
		newProps += "---"

		replacePropertiesFromEditor(this.editor, newProps)

		new Notice(`Added ${selectedProp.name}`)
	}
}

export function addWikiProperty(app: App, editor: Editor) {
	new PropertyModal(app, editor).open()
}
