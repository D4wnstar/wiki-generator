import markdownit from "markdown-it"
import { Notice, TFile, Vault, request } from "obsidian"
import { convertWikilinks, uploadImage } from "./wikilinks"
import { SupabaseClient } from "@supabase/supabase-js"
import * as MarkdownIt from "markdown-it"
import hljs from "highlight.js"
import { Database } from "./database/database.types"
import { storedMedia } from "./config"
import { calloutIcons, slugifyPath } from "./utils"

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
	alt_title: string | undefined
}

type SidebarImage = {
	image_name: string
	url: string | undefined
	caption: string | undefined
}

function parseProperties(match: string): NoteProperties {
	const props: NoteProperties = {
		publish: false,
		frontpage: false,
		alt_title: undefined,
	}
	const propsLines = match.split("\n")

	for (const line of propsLines) {
		const [key, value] = line.split(": ")
		switch (key) {
			case "wg-publish":
			case "dg-publish":
				if (value === "true") props.publish = true
				break
			case "wg-home":
			case "dg-home":
				if (value === "true") props.frontpage = true
				break
			case "wg-title":
			case "dg-title":
				props.alt_title = value
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

async function parseImage(
	match: RegExpMatchArray,
	vault: Vault,
	media: TFile[],
	supabase: SupabaseClient
): Promise<SidebarImage> {
	let filename: string | undefined
	let caption: string | undefined

	// Parse markdown for filename and captions
	// Unlike wikilinks, there's no need to check for user-defined dimensions
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

	// Grab that media file from the vault, if it exists. If it doesn't, it not might be a problem
	const refFile = media.find((file) => file.name === filename)
	if (!refFile) {
		console.warn(
			`Could not find file "${filename}". If this file doesn't yet exist, this is expected`
		)
		return {
			image_name: filename,
			url: undefined,
			caption: caption,
		}
	}

	// If it exists, read it as a binary ArrayBuffer and upload it
	const refFileBinary = await vault.readBinary(refFile)
	const url = await uploadImage(refFileBinary, filename, supabase)
	return {
		image_name: filename,
		url: url,
		caption: caption,
	}
}

function replaceCallouts(
	_match: string,
	type: string,
	title: string,
	content: string
) {
	let color: string
	let svg: string
	switch (type.toLowerCase()) {
		case "info":
			color = "primary"
			svg = calloutIcons.info
			break
		case "question":
		case "faq":
		case "help":
			color = "warning"
			svg = calloutIcons.circleQuestion
			break
		case "tip":
		case "important":
		case "hint":
			color = "tertiary"
			svg = calloutIcons.flame
			break
		case "success":
		case "check":
		case "done":
			color = "success"
			svg = calloutIcons.check
			break
		case "todo":
			color = "primary"
			svg = calloutIcons.circleCheck
			break
		case "warning":
		case "caution":
		case "attention":
			color = "warning"
			svg = calloutIcons.alertTriangle
			break
		case "failure":
		case "fail":
		case "missing":
			color = "error"
			svg = calloutIcons.cross
			break
		case "danger":
		case "error":
			color = "error"
			svg = calloutIcons.zap
			break
		case "bug":
			color = "error"
			svg = calloutIcons.bug
			break
		case "example":
			color = "secondary"
			svg = calloutIcons.list
			break
		case "quote":
		case "cite":
			color = "surface"
			svg = calloutIcons.quote
			break
		case "abstract":
		case "summary":
		case "tldr":
			color = "tertiary"
			svg = calloutIcons.clipboard
			break
		default:
			color = ""
			svg = ""
			break
	}

	return `<div class="callout-${color}"><div class="flex"><div class="w-8 stroke-${color}-400">${svg}</div><div class="pb-2"><strong>${title}</strong></div></div><p>${content}</p></div>`
}

function highlightCode(_match: string, lang: string, code: string) {
	let displayCode
	const langs = hljs.listLanguages()
	if (lang && langs.includes(lang)) {
		displayCode = hljs.highlight(code, { language: lang }).value
	} else displayCode = code

	return `
<div class="codeblock-base">
	<header class="codeblock-header">
		<span>${lang}</span>
	</header>
	<pre class="codeblock-pre">${displayCode}</pre>
</div>`
}

async function formatMd(
	md: string,
	vault: Vault,
	media: TFile[],
	supabase: SupabaseClient
): Promise<{
	md: string
	props: NoteProperties
	details: Map<string, string>
	sidebarImgs: SidebarImage[]
}> {
	const propsRegex = /^---\r?\n(.*?)\r?\n---/s
	const propsMatch = md.match(propsRegex)
	let props: NoteProperties = {
		publish: false,
		frontpage: false,
		alt_title: undefined,
	}
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
		sidebarImages.push(await parseImage(match, vault, media, supabase))
		md = md.replace(match[0], "")
	}

	md = md.replace(/^:::hidden\n.*?\n:::/gms, "") // Remove :::hidden::: blocks
	md = md.replace(/^#+ GM.*?(?=^#|$(?![\r\n]))/gms, "") // Remove GM paragraphs
	md = md.replace(
		/> \[!(\w+)\](?:\s*(.+)(?:\n>\s*(.*))?)?/g, // Replace callouts
		replaceCallouts
	)
	md = md.replace(/^```(\w*)\n(.*?)\n```/gms, highlightCode) // Highlight code blocks

	return {
		md: md,
		props: props,
		details: details,
		sidebarImgs: sidebarImages,
	}
}

async function vaultToNotes(
	converter: MarkdownIt,
	vault: Vault,
	supabase: SupabaseClient<Database>
): Promise<[Note[], TFile[]]> {
	const notes: Note[] = []
	// Get the non-markdown media first
	let files = vault.getFiles()
	const media = files.filter((file) => file.extension !== "md")

	// Then go through the markdown notes
	files = vault.getMarkdownFiles()
	for (const file of files) {
		const slug = slugifyPath(file.path.replace(".md", ""))

		const content = await vault.read(file)
		const formatted = await formatMd(content, vault, media, supabase)

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
			'<ul$1 class="list-disc list-inside indent-cascade">'
		)
		html = html.replace(
			/<ol(.*?)>/g,
			'<ol$1 class="list-decimal list-inside indent-cascade">'
		)
		html = html.replace(/<code>/g, '<code class="code">')

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
	supabase: SupabaseClient<Database>,
	deployHookUrl: string | undefined
): Promise<void> {
	const converter = markdownit({ html: true })

	// Create the media bucket if it doesn't exist
	const { data: buckets } = await supabase.storage.listBuckets()

	if (!buckets?.map((bucket) => bucket.name).includes("images")) {
		const { error: bucketError } = await supabase.storage.createBucket(
			"images",
			{
				public: true,
			}
		)

		if (
			bucketError &&
			bucketError.message !== "The resource already exists"
		) {
			throw new DatabaseError(bucketError.message)
		}
	} else {
		console.log("Media bucket already set up. Continuing...")
	}

	// Fetch a list of currently stored media files
	const { data, error: storageError } = await supabase
		.storage
		.from("images")
		.list()

	if (storageError) {
		throw new DatabaseError(
			`${storageError.message}\nIf you just created your Supabase database, try waiting a couple minutes and then try again.`
		)
	}

	console.log("Media files:", data)

	// Store those files globally (see storedMedia comment for why)
	storedMedia.files = data.map((file) => file.name)

	// Grab all the files, parse all markdown for custom syntax and upload sidebar images
	console.log("Fetching files from vault...")
	const files = await vaultToNotes(converter, vault, supabase)
	const [allNotes, localMedia] = files

	// Remove all notes that aren't set to be published
	let notes = allNotes.filter((note) => note.properties.publish)

	// Check if one and only one front page as been set among the published pages
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

	console.log("Converting notes...")
	new Notice("Converting notes...")
	// Convert all the [[wikilinks]] in the notes
	notes = await Promise.all(
		notes.map((note) =>
			convertWikilinks(note, notes, localMedia, vault, supabase)
		)
	)
	notes.sort((a, b) => a.slug.localeCompare(b.slug))

	console.log("Inserting content into Supabase. This might take a while...")
	new Notice("Inserting content into Supabase. This might take a while...")
	const notesInsertionResult = await supabase
		.from("notes")
		.upsert(
			notes.map((note) => {
				return {
					title: note.title,
					alt_title: note.properties.alt_title,
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

		if (detailsError) throw new DatabaseError(detailsError.message)

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

		if (backrefError) throw new DatabaseError(backrefError.message)

		const { error: imagesError } = await supabase
			.from("sidebar_images")
			.upsert(
				notes[index].sidebarImages.map((img) => {
					return {
						note_id: addedNotes[index].id,
						image_name: img.image_name,
						url: img.url,
						caption: img.caption,
					}
				})
			)

		if (imagesError) throw new DatabaseError(imagesError.message)
	}

	// Clean up remote notes by removing ones that have been deleted or set to unpublished locally
	const notesToDelete = []
	const { data: storedNotes, error: retrievalError } = await supabase.from(
		"notes"
	).select(`
            *,
            backreferences (*),
            details (*),
            sidebar_images (*)
        `)

	if (retrievalError) throw new DatabaseError(retrievalError.message)

	for (const remoteNote of storedNotes) {
		if (!notes.find((localNote) => localNote.title === remoteNote.title)) {
			notesToDelete.push(remoteNote)
		}
	}

	if (notesToDelete.length > 0) {
		console.log("Syncing notes...")
		new Notice("Syncing notes...")

		const slugsToDelete = notesToDelete.map((note) => note.slug)
		const idsToDelete = notesToDelete.map((note) => note.id)

		// Delete all details with matching id...
		const { error: detailsDeletionError } = await supabase
			.from("details")
			.delete()
			.in("note_id", idsToDelete)
		if (detailsDeletionError)
			throw new DatabaseError(detailsDeletionError.message)

		// ...all backreferences with matching id...
		const { error: backrefIdDeletionError } = await supabase
			.from("backreferences")
			.delete()
			.in("note_id", idsToDelete)
		if (backrefIdDeletionError)
			throw new DatabaseError(backrefIdDeletionError.message)

		// ...all backreferences with matching slug...
		const { error: backrefSlugDeletionError } = await supabase
			.from("backreferences")
			.delete()
			.in("slug", slugsToDelete)
		if (backrefSlugDeletionError)
			throw new DatabaseError(backrefSlugDeletionError.message)

		// ...and all sidebar images with matching id...
		const { error: sidebarImageDeletionError } = await supabase
			.from("sidebar_images")
			.delete()
			.in("note_id", idsToDelete)
		if (sidebarImageDeletionError)
			throw new DatabaseError(sidebarImageDeletionError.message)

		// ...and finally all notes with matching slugs
		const { data: deletedNotes, error: notesDeletionError } = await supabase
			.from("notes")
			.delete()
			.in("slug", slugsToDelete)
			.select()
		if (notesDeletionError)
			throw new DatabaseError(notesDeletionError.message)

		if (deletedNotes.length > 0) {
			console.log(
				`Deleted the following notes to keep the database synchronized: ${deletedNotes.map(
					(note) => note.slug
				)}`
			)
		}
	}

	// Also delete all backreferences from notes that have been removed or unplu

	// Clean up remote files by removing ones that have been deleted locally
	// TODO: Also remove files that are no longer referenced by any note
	const localMediaCorrectExt = localMedia.map((file) =>
		file.name.replace(/\..*$/, ".webp")
	)
	const mediaToDelete: string[] = []
	for (const filename of storedMedia.files) {
		if (!localMediaCorrectExt.find((name) => name === filename)) {
			mediaToDelete.push(filename)
		}
	}

	if (mediaToDelete.length > 0) {
		console.log("Syncing media...")
		new Notice("Syncing media...")

		const { data: deletedMedia, error: deletionError } =
			await supabase.storage.from("images").remove(mediaToDelete)

		if (deletionError) throw new DatabaseError(deletionError.message)
		console.log(
			`Removed the following files to keep the database synchronized: ${deletedMedia.map(
				(file) => file.name
			)}`
		)

		const { error: dbDeletionError } = await supabase
			.from("stored_media")
			.delete()
			.in("media_name", mediaToDelete)

		if (dbDeletionError) throw new DatabaseError(dbDeletionError.message)
	}

	// Finally, send a request to Vercel to rebuild the website
	if (deployHookUrl) {
		console.log("Deploying the website...")
		new Notice("Deploying the website...")
		await request(deployHookUrl)
	}
}
