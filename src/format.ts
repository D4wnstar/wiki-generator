import markdownit from "markdown-it"
import slugify from "slugify"
import { TFile, Vault } from "obsidian"
import { writeFileSync } from "fs"
import { join } from "path"
import { convertWikilinks } from "./wikilinks"
import { createClient } from "@supabase/supabase-js"
import * as MarkdownIt from "markdown-it"
import { Database } from "./database.types"

export class NoFrontPageError extends Error {
  constructor(message: string) {
	super(message); // Pass the message to the Error constructor
	this.name = "NoFrontPageError"; // Set the name of the error
  }
}

export class DatabaseError extends Error {
  constructor(message: string) {
	super(message); // Pass the message to the Error constructor
	this.name = "DatabaseError"; // Set the name of the error
  }
}

export type Note = {
	title: string
	path: string
	slug: string
	content: string
	references: Set<string>
	backreferences: Backreference[]
	properties: NoteProperties
	details: Map<string, string>
}

export type Backreference = {
	displayName: string
	slug: string
}

type NoteProperties = {
	publish: boolean
	frontpage: boolean
}

type NotesData = {
	frontpage: Note
	notes: Note[]
}

export function slugifyPath(path: string): string {
	const elems = path.split("/").filter((elem) => elem !== "")
	const slugged = []
	for (const elem of elems) {
		slugged.push(slugify(elem, { lower: true, remove: /[^\w\d\s]/g }))
	}

	return slugged.join("/")
}

function parseProperties(match: string): NoteProperties {
	const props: NoteProperties = { publish: false, frontpage: false }
	const propsLines = match.split("\n")
	for (const line of propsLines) {
		const kv = line.split(": ")
		switch (kv[0]) {
			case "dg-publish":
				if (kv[1] === "true") {
					props.publish = true
				}
				break
			case "dg-home":
				if (kv[1] === "true") {
					props.frontpage = true
				}
				break
			default:
				break
		}
	}
	return props
}

function parseDetails(match: string): Map<string, string> {
	const detailsMap = new Map<string, string>()
	const details = match.split("\n").filter((line) => line !== "")

	for (const detail of details) {
		const [kConst, v] = detail.split(/:\s*/)
		let k = kConst // Literally just to make ESLint not complain about using let instead of const
		k = k.replace(/^(_|\*)+/, "").replace(/(_|\*)+$/, "")
		detailsMap.set(k, v)
	}

	return detailsMap
}

function formatMd(md: string): [string, NoteProperties, Map<string, string>] {
	const propsRegex = /^---\r?\n(.*?)\r?\n---/s
	const propsMatch = md.match(propsRegex)
	let props: NoteProperties = { publish: false, frontpage: false }
	if (propsMatch) {
		props = parseProperties(propsMatch[1]) // Save some properties before removing them
		md = md.replace(propsRegex, "") // Remove obsidian properties
	}

	const detailsRegex = /^:::details\n(.*?)\n:::/ms // Finds the first occurence of :::details:::
	const detailsMatch = md.match(detailsRegex)
	let details = new Map<string, string>()
	if (detailsMatch) {
		details = parseDetails(detailsMatch[1])
		md = md.replace(detailsRegex, "") // Remove details from the main page
	}

	md = md.replace(/^:::hidden\n.*?\n:::/gms, "") // Remove :::hidden::: blocks
	md = md.replace(/^#+ GM.*?(?=^#|$(?![\r\n]))/gms, "") // Remove GM paragraphs
	return [md, props, details]
}

async function readVault(
	converter: MarkdownIt,
	vault: Vault
): Promise<[Note[], TFile[]]> {
	const notes: Note[] = []
	const media: TFile[] = []
	const mdFiles = vault.getFiles()

	for (const file of mdFiles) {
		if (file.extension !== "md") {
			media.push(file)
			continue
		}

		const slug = slugifyPath(file.path.replace(".md", ""))

		let content = await vault.read(file)
		const out = formatMd(content)
		content = out[0]
		const props = out[1]
		const details = out[2]

		let html = converter.render(content)
		html = html.replace(
			/<h(\d)(.*?)>(.*?)<\/h\d>/g,
			'<h$1$2 class="h$1">$3</h$1>'
		)
		html = html.replace(
			/<a(.*?)>(.*?)<\/a>/g,
			'<a$1 class="anchor" target="_blank">$2</a>'
		)
		html = html.replace(/<blockquote>/g, '<blockquote class="blockquote">')
		html = html.replace(
			/<ul>/g,
			'<ul class="list-disc list-inside [&_&]:pl-5">'
		)
		html = html.replace(
			/<ol>/g,
			'<ul class="list-decimal list-inside [&_&]:pl-5">'
		)

		notes.push({
			title: file.name.replace(".md", ""),
			path: file.path.replace(".md", ""),
			slug: slug,
			content: html,
			references: new Set<string>(),
			backreferences: [],
			properties: props,
			details: details,
		})
	}
	return [notes, media]
}

function noteToString(note: Note): string {
	let out = ""
	out += "{"
	out += `\n\t\ttitle: "${note.title}",`
	out += `\n\t\tpath: "${note.path}",`
	out += `\n\t\tslug: "${note.slug}",`
	out += `\n\t\treferences: [`
	for (const ref of note.references) {
		out += `"${ref}", `
	}
	out += `],`
	out += `\n\t\tbackreferences: [`
	for (const ref of note.backreferences) {
		out += `{displayName: "${ref.displayName}", slug: "${ref.slug}"}, `
	}
	out += `],`
	out += `\n\t\tcontent: \`${note.content}\`,`
	out += `\n\t\tproperties: { publish: ${note.properties.publish}, frontpage: ${note.properties.frontpage} },`
	out += "\n\t}"

	return out
}

export async function convertNotesForUpload(
	vault: Vault,
	outPath: string,
	supabaseUrl: string,
	supabaseAnonKey: string,
	supabaseServiceKey: string
): Promise<void> {
	const supabase = createClient<Database>(supabaseUrl, supabaseServiceKey)

	const converter = markdownit()
	const files = await readVault(converter, vault)
	let notes = files[0]
	const media = files[1]

	const { data, error } = await supabase.storage.from("images").list()

	if (error) {
		console.error(
			"Could not reach Supabase Storage. Got the following error:",
			error.message
		)
		console.error(error)
		return
	}

	notes = await Promise.all(
		notes.map((note) =>
			convertWikilinks(note, notes, media, vault, data, supabase)
		)
	)
	notes.sort((a, b) => a.slug.localeCompare(b.slug))

	const notesData: NotesData = {
		frontpage: {
			title: "",
			path: "",
			slug: "",
			content: "",
			references: new Set(),
			backreferences: [],
			properties: {
				publish: false,
				frontpage: false,
			},
			details: new Map(),
		},
		notes: [],
	}

	let notesJsonString = ""
	// Change .find to .filter and check if the resulting array has a length of 1
	// to prevent possibly weird behaviour in case user sets more than one front page
	const frontpage = notes.find((note) => note.properties.frontpage)
	if (frontpage) {
		// notesJsonString += "export const frontpage = "
		// notesJsonString += noteToString(frontpage)
		// notesJsonString += "\n"
		notesData.frontpage = frontpage
	} else {
		throw new NoFrontPageError(
			"ERROR: No page has been set as the front page. One front page must be set by adding the dg-home: true property to a note."
		)
	}

	notesJsonString += "export const notes = [\n"
	for (const note of notes) {
		// if (!note.properties.publish || note.properties.frontpage) {
		// 	continue
		// }
		// notesJsonString += "\t"
		// notesJsonString += noteToString(note)
		// notesJsonString += ",\n"
		notesData.notes.push(note)
	}
	notesJsonString += "]"

	const dump = JSON.stringify(notesData, (_, value) => {
		if (value instanceof Map || value instanceof Set) {
			return [...value]
		} else {
			return value
		}
	})

	writeFileSync(join(outPath, "notes-data.json"), dump, {
		encoding: "utf-8",
	})

	const notesInsertionResult = await supabase
		.from('notes')
		.upsert(notes.map((note) => {
			return {
				title: note.title,
				path: note.path,
				slug: note.slug,
				content: note.content,
				publish: note.properties.publish,
				frontpage: note.properties.frontpage,
				references: [...note.references]
			}
		}), {
			onConflict: 'slug', // Treat rows with the same slug as duplicate pages
			ignoreDuplicates: false, // Merge information of duplicate pages to keep things updated
		})
		.select()

	if (notesInsertionResult.error) {
		throw new DatabaseError(notesInsertionResult.error.message)
	}

	const addedNotes = notesInsertionResult.data

	for (const index in notes) {
		const { error: detailsError } = await supabase
			.from('details')
			.upsert([...notes[index].details.entries()].map((pair) => {
				return {
					note_id: addedNotes[index].id,
					detail_name: pair[0],
					detail_content: pair[1]
				}
			}))
		
		if (detailsError) { throw new DatabaseError(detailsError.message) }

		const { error: backrefError } = await supabase
			.from('backreferences')
			.upsert(notes[index].backreferences.map((backref) => {
				return {
					note_id: addedNotes[index].id,
					display_name: backref.displayName,
					slug: backref.slug
				}
			}))
		
		if (backrefError) { throw new DatabaseError(backrefError.message) }
	}
	
}

/*
notes-data.json schema

{
	"frontpage": Note,
	"notes": {
		title: string
		path: string
		slug: string
		content: string
		references: string[]
		backreferences: { displayName: string, slug: string }[]
		properties: { publish: boolean, frontpage: boolean }
		details: { detailName: string, detailContent: string }[]
	}[]
}
*/
