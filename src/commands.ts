import { Notice } from "obsidian"
import { convertNotesAndUpload } from "./notes/upload"
import { WikiGeneratorSettings } from "./settings"
import {
	getPublishableFiles,
} from "./utils"
import { FrontPageError, DatabaseError } from "./notes/types"
import { globalVault, supabase } from "main"

export async function uploadNotes(settings: WikiGeneratorSettings) {
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
		await convertNotesAndUpload()
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

export function massAddPublish(settings: WikiGeneratorSettings) {
	const notes = getPublishableFiles(settings)
	for (const note of notes) {
		globalVault.process(note, (noteText) => {
			const propsRegex = /^---\n+(.*?)\n+---/s
			// Isolate properties
			const props = noteText.match(propsRegex)
			if (props) {
				// Check if a publish property is already there
				const publish = props[1].match(
					/(wiki)|(dg)-publish: (true)|(false)/
				)
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
	settings: WikiGeneratorSettings,
	state: boolean
) {
	const notes = getPublishableFiles(settings)
	const regex = RegExp(
		`^---\n(.*?)wiki-publish: ${state}(.*?)\n---\n`,
		"s"
	)
	for (const note of notes) {
		globalVault.process(note, (noteText) => {
			return noteText.replace(
				regex,
				`---\n$1$2-publish: ${state}$3\n---`
			)
		})
	}
}
