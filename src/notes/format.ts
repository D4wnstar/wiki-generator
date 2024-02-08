import markdownit from "markdown-it"
import { Notice, TFile, request } from "obsidian"
import { convertWikilinks, uploadImage } from "./wikilinks"
import * as MarkdownIt from "markdown-it"
import hljs from "highlight.js"
import { localMedia, supabaseMedia } from "../config"
import { calloutIcons, partition, slugifyPath } from "../utils"
import {
	NoteProperties,
	SidebarImage,
	Note,
	DatabaseError,
	FrontPageError,
	ContentChunk,
} from "./types"
import { setupMediaBucket } from "src/database/init"
import { globalVault, supabase } from "main"

function parseProperties(match: string): NoteProperties {
	const props: NoteProperties = {
		publish: false,
		frontpage: false,
		alt_title: undefined,
		allowed_users: [],
	}
	const propsLines = match.split("\n")

	for (const line of propsLines) {
		const [key, value] = line.split(": ")
		switch (key) {
			case "wiki-publish":
			case "dg-publish":
				if (value === "true") props.publish = true
				break
			case "wiki-home":
			case "dg-home":
				if (value === "true") props.frontpage = true
				break
			case "wiki-title":
			case "dg-title":
				props.alt_title = value
				break
			case "wiki-allowed-users":
				props.allowed_users = value.split(",")
				props.allowed_users.forEach((username) => username.trim())
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
	media: TFile[]
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
	const refFileBinary = await globalVault.readBinary(refFile)
	const url = await uploadImage(refFileBinary, filename)
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

/**
 * Splits markdown into chunks with metadata attached to them. Primarily, this allows each
 * chunk to have a different authorization level so that it's possible to hide only certain
 * parts of a page instead of just the whole page.
 * @param md The text to split
 * @returns An array of chunks with metadata
 */
function chunkMd(md: string): ContentChunk[] {
	const privateChunks = Array.from(
		md.matchAll(/^:::private\s*\((.*?)\)\n(.*?)\n:::/gms)
	)
	if (privateChunks.length === 0) return [{ chunk_id: 1, text: md, allowed_users: [] }]

	// Unwrap the tags and keep only the inner content
	md = md.replace(/^:::private\s*\((.*?)\)\n(.*?)\n:::/gms, "$2")

	let currChunkId = 1
	const chunks: ContentChunk[] = []

	for (const match of privateChunks) {
		let currText: string
		const users = match[1]?.split(",").map((s) => s.trim()) ?? []

		if (chunks.length > 0) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			currText = chunks.pop()!.text
			currChunkId -= 1
		} else {
			currText = md
		}

		const parts = partition(currText, match[2])
		for (const i in parts) {
			chunks.push({
				chunk_id: currChunkId,
				text: parts[i],
				allowed_users: parseInt(i) % 2 !== 0 ? users : [],
				// The way `partition` works puts all private chunks on odd indexes
			})
			currChunkId += 1
		}
	}

	return chunks
}

async function formatMd(
	md: string,
	media: TFile[]
): Promise<{
	chunks: ContentChunk[]
	lead: string,
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
		allowed_users: [],
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
		sidebarImages.push(await parseImage(match, media))
		md = md.replace(match[0], "")
	}

	md = md.replace(/^:::hidden\n.*?\n:::/gms, "") // Remove :::hidden::: blocks
	// TODO: Remove the whole GM paragraph thing
	md = md.replace(/^#+ GM.*?(?=^#|$(?![\r\n]))/gms, "") // Remove GM paragraphs
	md = md.replace(
		/> \[!(\w+)\](?:\s*(.+)(?:\n>\s*(.*))?)?/g, // Replace callouts
		replaceCallouts
	)
	md = md.replace(/^```(\w*)\n(.*?)\n```/gms, highlightCode) // Highlight code blocks

	const match = md.match(/\n*(.*?)\n\n/) // Get everything until the first double newline as the lead
	let lead = md
	if (match) lead = match[1]
	// Remove wikilinks from lead
	lead = lead.replace(/\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/g, "$1")
	lead = lead.replace(/!\[\[(.*?)\]\]/g, "")

	const chunks = chunkMd(md) // Split by :::private::: blocks
	return {
		chunks: chunks,
		lead: lead,
		props: props,
		details: details,
		sidebarImgs: sidebarImages,
	}
}

function fixHtml(html: string): string {
	// Improve headers
	html = html.replace(
		/<h(\d)(.*?)>(.*?)<\/h\d>/g,
		(_substring, num, props, content) => {
			const id = slugifyPath(content)
			return `<h${num}${props} class="h${num}" id="${id}">${content}</h${num}>`
		}
	)
	// Make all external links open a new tab
	html = html.replace(
		/<a(.*?)>(.*?)<\/a>/g,
		'<a$1 class="anchor" target="_blank">$2</a>'
	)
	// Add tailwind classes to blockquotes, code and lists
	html = html.replace(
		/<blockquote>/g,
		'<blockquote class="blockquote">'
	)
	html = html.replace(
		/<ul(.*?)>/g,
		'<ul$1 class="list-disc list-inside indent-cascade">'
	)
	html = html.replace(
		/<ol(.*?)>/g,
		'<ol$1 class="list-decimal list-inside indent-cascade">'
	)
	html = html.replace(/<code>/g, '<code class="code">')

	return html
}

async function vaultToNotes(converter: MarkdownIt): Promise<[Note[], TFile[]]> {
	const notes: Note[] = []
	// Get the non-markdown media first
	let files = globalVault.getFiles()
	const media = files.filter((file) => file.extension !== "md")

	// Then go through the markdown notes
	files = globalVault.getMarkdownFiles()
	for (const file of files) {
		const slug = slugifyPath(file.path.replace(".md", ""))

		const content = await globalVault.read(file)
		const formatted = await formatMd(content, media)

		for (const i in formatted.chunks) {
			// Replace the markdown with the HTML
			const html = converter.render(formatted.chunks[i].text)
			formatted.chunks[i].text = fixHtml(html)
		}

		const leadHtml = converter.render(formatted.lead)
		formatted.lead = fixHtml(leadHtml)

		notes.push({
			title: file.name.replace(".md", ""),
			path: file.path.replace(".md", ""),
			slug: slug,
			content: formatted.chunks,
			lead: formatted.lead,
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
	deployHookUrl: string | undefined
): Promise<void> {
	const converter = markdownit({ html: true })

	await setupMediaBucket()

	// Fetch a list of currently stored media files
	const { data: mediaInStorage, error: storageError } = await supabase.storage
		.from("images")
		.list()

	if (storageError) {
		throw new DatabaseError(
			`${storageError.message}\nIf you just created your Supabase database, try waiting a couple minutes and then try again.`
		)
	}

	// Store those files globally (see supabaseMedia comment for why)
	supabaseMedia.files = mediaInStorage.map((file) => file.name)

	// Grab all the files, parse all markdown for custom syntax and upload sidebar images
	console.log("Fetching files from vault...")
	const [allNotes, mediaInVault] = await vaultToNotes(converter)

	// Store local files globally (same reasoning as supabaseMedia)
	localMedia.files = mediaInVault

	// Remove all notes that aren't set to be published
	let notes = allNotes.filter((note) => note.properties.publish)

	// Check if one and only one front page as been set among the published pages
	const frontpageArray = notes.filter((note) => note.properties.frontpage)
	if (frontpageArray.length === 0) {
		throw new FrontPageError(
			"ERROR: No page has been set as the front page. One front page must be set by adding the wiki-home: true property to a note."
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

	// Convert all the [[wikilinks]] in the notes
	console.log("Converting notes...")
	new Notice("Converting notes...")
	notes = await convertWikilinks(notes)
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
					lead: note.lead,
					slug: note.slug,
					frontpage: note.properties.frontpage,
					references: [...note.references],
					allowed_users: note.properties.allowed_users,
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
		const { error: contentError } = await supabase
			.from("note_contents")
			.upsert(
				notes[index].content.map((chunk) => {
					return {
						note_id: addedNotes[index].id,
						...chunk,
					}
				}),
				{ ignoreDuplicates: false },
			)

		if (contentError) throw new DatabaseError(contentError.message)

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

	// Clean up remote files by removing ones that have been deleted locally
	// TODO: Also remove files that are no longer referenced by any note
	const localMediaCorrectExt = localMedia.files.map((file) =>
		file.name.replace(/\..*$/, ".webp")
	)
	const mediaToDelete: string[] = []
	for (const filename of supabaseMedia.files) {
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
