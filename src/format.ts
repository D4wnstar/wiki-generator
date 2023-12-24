import markdownit from "markdown-it"
import slugify from "slugify"
import { TFile, Vault } from "obsidian"
import { convertWikilinks } from "./wikilinks"
import { createClient } from "@supabase/supabase-js"
import * as MarkdownIt from "markdown-it"
import { Database } from "./database.types"
import { writeFileSync } from "fs"
import { join } from "path"

export class FrontPageError extends Error {
	constructor(message: string) {
		super(message) // Pass the message to the Error constructor
		this.name = "NoFrontPageError" // Set the name of the error
	}
}

export class DatabaseError extends Error {
	constructor(message: string) {
		super(message) // Pass the message to the Error constructor
		this.name = "DatabaseError" // Set the name of the error
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
	sidebarImages: SidebarImage[]
}

export type Backreference = {
	displayName: string
	slug: string
}

type NoteProperties = {
	publish: boolean
	frontpage: boolean
}

type SidebarImage = {
	image_name: string
	caption: string | undefined
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

function parseImage(match: RegExpMatchArray): SidebarImage {
	let filename: string | undefined = undefined
	let caption: string | undefined = undefined

	const lines = match[0].split("\n").filter((line) => line !== "")
	for (const line of lines) {
		const wikilink = line.match(/!\[\[(.*?)(\|.*)?\]\]/)
		if (wikilink) {
			filename = wikilink[1]
			continue
		}
		const capMatch = line.match(/\*Caption:\s*(.*)\*/)
		if (capMatch) {
			caption = capMatch[1]
		}
	}

	if (!filename) {
		throw new Error("Invalid formatting for :::image::: block.")
	}

	return {
		image_name: filename,
		caption: caption,
	}
}

function formatMd(md: string): {
	md: string
	props: NoteProperties
	details: Map<string, string>
	sidebarImgs: SidebarImage[]
} {
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

	const imageRegex = /^:::image\n(.*?)\n:::/gms // Finds all occurences of :::image:::
	const imageMatch = md.matchAll(imageRegex)
	const sidebarImages: SidebarImage[] = []
	for (const match of imageMatch) {
		sidebarImages.push(parseImage(match))
		md = md.replace(match[0], "")
	}

	md = md.replace(/^:::hidden\n.*?\n:::/gms, "") // Remove :::hidden::: blocks
	md = md.replace(/^#+ GM.*?(?=^#|$(?![\r\n]))/gms, "") // Remove GM paragraphs
	return {
		md: md,
		props: props,
		details: details,
		sidebarImgs: sidebarImages,
	}
}

async function vaultToNotes(
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

		const content = await vault.read(file)
		const formatted = formatMd(content)

		let html = converter.render(formatted.md)
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
			/<ul(.*?)>/g,
			'<ul$1 class="list-disc list-inside [&_&]:pl-5">'
		)
		html = html.replace(
			/<ol(.*?)>/g,
			'<ol$1 class="list-decimal list-inside [&_&]:pl-5">'
		)

		notes.push({
			title: file.name.replace(".md", ""),
			path: file.path.replace(".md", ""),
			slug: slug,
			content: html,
			references: new Set<string>(),
			backreferences: [],
			properties: formatted.props,
			details: formatted.details,
			sidebarImages: formatted.sidebarImgs,
		})
	}
	return [notes, media]
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
	const files = await vaultToNotes(converter, vault)
	const [allNotes, media] = files
	let notes = allNotes.filter((note) => note.properties.publish) // Remove all notes that aren't set to be published

	const { data: storedMedia, error: storageError } = await supabase.storage
		.from("images")
		.list()

	if (storageError) {
		throw new DatabaseError(
			`${storageError.message}\nIf you just created your Supabase database, try waiting a couple minutes and then try again.`
		)
	}

	notes = await Promise.all(
		notes.map((note) =>
			convertWikilinks(note, notes, media, vault, storedMedia, supabase)
		)
	)
	notes.sort((a, b) => a.slug.localeCompare(b.slug))

	const frontpageArray = notes.filter((note) => note.properties.frontpage)
	if (frontpageArray.length === 0) {
		throw new FrontPageError(
			"ERROR: No page has been set as the front page. One front page must be set by adding the dg-home: true property to a note."
		)
	} else if (frontpageArray.length > 1) {
		throw new FrontPageError(
			`ERROR: Multiple pages have been set as the front page.
			Please only set a single page as the front page.
			The relevant pages are ${frontpageArray.reduce(
				(prev, curr) => `${prev}\n${curr.path}`,
				"\n"
			)}`
		)
	}

	writeFileSync(join(outPath, "notes-data.json"), JSON.stringify(notes))

	const notesInsertionResult = await supabase
		.from("notes")
		.upsert(
			notes.map((note) => {
				return {
					title: note.title,
					path: note.path,
					slug: note.slug,
					content: note.content,
					frontpage: note.properties.frontpage,
					references: [...note.references],
				}
			}),
			{
				onConflict: "slug", // Treat rows with the same slug as duplicate pages
				ignoreDuplicates: false, // Merge information of duplicate pages to keep things updated
			}
		)
		.select()

	if (notesInsertionResult.error) {
		throw new DatabaseError(notesInsertionResult.error.message)
	}

	const addedNotes = notesInsertionResult.data

	for (const index in notes) {
		const { error: detailsError } = await supabase.from("details").upsert(
			[...notes[index].details.entries()].map((pair) => {
				return {
					note_id: addedNotes[index].id,
					detail_name: pair[0],
					detail_content: pair[1],
				}
			})
		)

		if (detailsError) {
			throw new DatabaseError(detailsError.message)
		}

		const { error: backrefError } = await supabase
			.from("backreferences")
			.upsert(
				notes[index].backreferences.map((backref) => {
					return {
						note_id: addedNotes[index].id,
						display_name: backref.displayName,
						slug: backref.slug,
					}
				})
			)

		if (backrefError) {
			throw new DatabaseError(backrefError.message)
		}

		// Transfrom the names of the images into the corresponding public URL
		notes[index].sidebarImages = await Promise.all(
			notes[index].sidebarImages.map(async (img) => {
				const {
					data: { publicUrl },
				} = supabase.storage.from("images").getPublicUrl(img.image_name)
				return {
					image_name: publicUrl,
					caption: img.caption,
				}
			})
		)

		const { error: imagesError } = await supabase
			.from("sidebar_images")
			.upsert(
				notes[index].sidebarImages.map((img) => {
					return {
						note_id: addedNotes[index].id,
						image_name: img.image_name,
						caption: img.caption,
					}
				})
			)

		if (imagesError) {
			throw new DatabaseError(imagesError.message)
		}
	}
}
