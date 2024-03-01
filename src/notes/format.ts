import { TFile } from "obsidian"
import { uploadImage } from "./wikilinks"
import * as MarkdownIt from "markdown-it"
import hljs from "highlight.js"
import { calloutIcons, partition, slugifyPath } from "../utils"
import { NoteProperties, SidebarImage, Note, ContentChunk } from "./types"
import { globalVault } from "main"

export async function vaultToNotes(
	converter: MarkdownIt
): Promise<[Note[], TFile[]]> {
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
	content: string,
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

	content = content
		.split("\n")
		.map((line) => {
			line = line.replace(/^> */, "")
			return `<p>${line}</p>`
		})
		.filter((line) => line !== "<p></p>")
		.join("\n")

	return `<div class="callout-${color}"><div class="flex"><div class="w-8 stroke-${color}-400">${svg}</div><div class="pb-2"><strong>${title}</strong></div></div><section class="space-y-4">${content}</section></div>`
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
function chunkMd(md: string, allowedUsers: string[]): ContentChunk[] {
	const privateChunks = Array.from(
		md.matchAll(/^:::private\s*\((.*?)\)\n(.*?)\n:::/gms)
	)
	if (privateChunks.length === 0)
		return [{ chunk_id: 1, text: md, allowed_users: allowedUsers }]

	// Unwrap the tags and keep only the inner content
	md = md.replace(/^:::private\s*\((.*?)\)\n(.*?)\n:::/gms, "$2")

	let currChunkId = 1
	const chunks: ContentChunk[] = []

	for (const match of privateChunks) {
		let currText: string
		const users = match[1].split(",").map((s) => s.trim())

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
				allowed_users: parseInt(i) % 2 !== 0 ? users : allowedUsers,
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
	lead: string
	props: NoteProperties
	details: Map<string, string>
	sidebarImgs: SidebarImage[]
}> {
	// Collect all properties
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

	// Find the first occurence of :::details:::
	const detailsRegex = /^:::details\n(.*?)\n:::/ms
	const detailsMatch = md.match(detailsRegex)
	let details = new Map<string, string>()
	if (detailsMatch) {
		details = parseDetails(detailsMatch[1])
		md = md.replace(detailsRegex, "") // Remove details from the main page
	}

	// Find all occurences of :::image:::
	const imageRegex = /^:::image\n(.*?)\n:::/gms
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
		/^> +\[!(\w+)\] *(.*)(?:\n(>[^]*?))?(?=\n[^>])/gm, // Replace callouts
		replaceCallouts
	)
	md = md.replace(/^```(\w*)\n(.*?)\n```/gms, highlightCode) // Highlight code blocks

	// Get everything until the first header as the lead
	const match = md.match(/\n*#*(.+?)(?=#)/s)
	let lead = match ? match[1] : md
	// Remove wikilinks from lead
	lead = lead.replace(/\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/g, "$1")
	lead = lead.replace(/!\[\[(.*?)\]\]/g, "")

	const chunks = chunkMd(md, props.allowed_users) // Split by :::private::: blocks
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

	return html
}
