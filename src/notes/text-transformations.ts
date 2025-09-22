import { App, Component, MarkdownRenderer, TFile } from "obsidian"
import { addCode, handleCustomSyntax, removeCode } from "./custom-blocks"
import { Frontmatter, Note, Page } from "../database/types"
import { RouteManager } from "src/commands"

// No official ES6 way of importing katex AND the mhchem extension
const katex = require("katex")
require("katex/contrib/mhchem")

/**
 * Create a `Page` object from the given Markdown file, which means processing
 * all Markdown in the file and providing the converted HTML for the website alongside
 * any additional components.
 * @returns A `Page` containing everything about the given file
 */
export async function createPage(
	file: TFile,
	hash: string,
	routes: RouteManager,
	imageNameToPath: Map<string, string>,
	app: App
): Promise<Page | null> {
	const content = await app.vault.cachedRead(file)
	const frontmatter = await extractFrontmatter(file, app)

	// Skip anything that's not published
	if (!frontmatter["wiki-publish"]) return null

	// Parse and replace custom :::blocks::: and other non-standard syntax
	const parsed = await handleCustomSyntax(
		content,
		file.name,
		app,
		routes,
		imageNameToPath
	)

	// Convert the entire markdown to HTML using Obsidian's builtin renderer
	let html = await mdToHtml(parsed.md, app, routes, imageNameToPath)

	// Manage titles and routes
	const route = routes.getRoute(file.path) ?? file.basename.replace(/ /g, "_")
	const alt_title = frontmatter["wiki-title"] ?? null
	const title = alt_title ?? file.basename
	const aliases = frontmatter["aliases"]?.join("; ") as string | undefined
	const search_terms = title + (aliases ? `; ${aliases}` : "")

	// A page is secret if there are allowed users (not null and not empty) or
	// if there are any secret blocks. Nonsecret pages can be prerendered
	const allowed_users = frontmatter["wiki-allowed-users"]?.join("; ") ?? null
	const isSecret = allowed_users || parsed.isSecret

	const note: Note = {
		title,
		route,
		search_terms,
		path: file.path,
		frontpage: frontmatter["wiki-home"] ?? 0,
		lead: "", // Currently unused, needed for popups once they are reimplemented
		allowed_users,
		hash,
		last_updated: Math.floor(Date.now() / 1000),
		can_prerender: Number(!isSecret),
		html_content: html.trim(),
	}

	return {
		note,
		details: parsed.details,
		sidebarImages: parsed.sidebarImages,
	}
}

/**
 * Return the file's frontmatter as an object.
 */
async function extractFrontmatter(file: TFile, app: App) {
	let frontmatter: Frontmatter
	return app.fileManager
		.processFrontMatter(file, (matter) => (frontmatter = matter))
		.then(() => frontmatter)
}

/**
 * Convert a Markdown string into HTML using Obsidian's builtin converter,
 * then postprocess the HTML to fix/modify tags to a more useful form.
 * @returns The converted HTML
 */
export async function mdToHtml(
	md: string,
	app: App,
	routes: RouteManager,
	imageNameToPath: Map<string, string>,
	options?: { unwrap?: boolean }
) {
	// Create a temporary element to render the markdown to
	const tempEl = document.createElement("div")

	try {
		const math = removeMath(md)
		await MarkdownRenderer.render(app, math.md, tempEl, "", new Component())
		const html = postprocessHtml(
			tempEl.innerHTML,
			routes,
			imageNameToPath,
			options?.unwrap
		)
		return addMath(html, math.blocks, math.inline)
	} finally {
		tempEl.remove()
	}
}

function removeMath(md: string) {
	// Bypass MathJax entirely and use KaTeX instead
	const code = removeCode(md)
	md = code.md

	const blocks = Array.from(md.matchAll(/\$\$(.*?)\$\$/gs))
		.map((block) =>
			block[1]
				.replace(/^>\s+/gm, "")
				.replace("\n", "")
				.replace(
					/\\(begin|end)\{(equation|gather|align|alignat)\}/g,
					"\\$1{$2*}"
				)
		)
		.reverse()
	md = md.replace(/\$\$.*?\$\$/gs, "###math###")

	const inline = Array.from(md.matchAll(/\$(.*?)\$/g))
		.map((code) => code[1])
		.reverse()
	md = md.replace(/\$.*?\$/g, "###math-inline###")

	md = addCode(md, code.blocks, code.inline)
	return { md, blocks, inline }
}

function addMath(html: string, block: string[], inline: string[]) {
	// Some fixes to convert MathJax format into KaTeX format and alleviate issues
	// KaTeX macros are not used because they expand recursively, making them unusable
	// if they expand into something that contains the original (infinite loop)
	const fixes: [RegExp, string][] = [
		[/\\textendash/g, "\\text{\\textendash}"],
		[/\\textemdash/g, "\\text{\\textemdash}"],
	]

	const fixMath = (math: string) => {
		for (const [key, value] of fixes) {
			math = math.replace(key, value)
		}
		return math
	}

	const render = (array: string[], displayMode: boolean) => {
		try {
			const math = fixMath(array.pop() ?? "")
			return katex.renderToString(math, {
				displayMode,
				strict: false, // MathJax compatibility
				colorIsTextColor: true, // MathJax compatibility
			})
		} catch (e) {
			console.warn(
				`Couldn't render math. ${e}.\n${html.substring(0, 400)}`
			)
			return "[Math rendering error]"
		}
	}

	// Add KaTeX math manually
	html = html.replace(/###math###(<br>)?/g, () => render(block, true))
	html = html.replace(/###math-inline###/g, () => render(inline, false))

	return html
}

/**
 * Process an HTML string to run a bunch of miscellaneous changes and fixes to
 * Obsidian HTML. This is done to turn the HTML in a more useful form for the frontend.
 * @returns The processed HTML
 */
export function postprocessHtml(
	html: string,
	routes: RouteManager,
	imageNameToPath: Map<string, string>,
	unwrap?: boolean
) {
	const parser = new DOMParser()
	const doc = parser.parseFromString(html, "text/html")

	// Remove empty <p> tags
	const emptyPs = Array.from(doc.querySelectorAll("p"))
	for (const empty of emptyPs) {
		if (empty.childElementCount === 0 && empty.textContent === "") {
			empty.remove()
		}
	}

	// Unwrap the topmost element if requested
	if (unwrap && doc.body.firstElementChild) {
		doc.body.replaceChildren(
			...Array.from(doc.body.firstElementChild.childNodes)
		)
	}

	// Remove frontmatter
	doc.querySelectorAll("pre.frontmatter").forEach((pre) => pre.remove())

	// Change link URLs to be actual website URLs
	const links = Array.from(doc.querySelectorAll("a")).reverse()
	for (const link of links) {
		// Remove some fluff
		link.removeAttribute("data-href")
		link.removeAttribute("data-tooltip-position")

		// Get the href and leave external links alone
		const href = link.getAttribute("href")
		if (!href || link.className.includes("external-link")) continue

		// Remove target="_blank" and classes from internal links
		link.removeAttribute("target")
		link.removeAttribute("class")

		// Leave internal header links and already converted ones alone
		if (href.startsWith("#") || href.startsWith("/wiki/")) continue

		// Get the filename or filepath without any hash fragment
		const hashIndex = href.indexOf("#")
		let titleOrPath = hashIndex > -1 ? href.substring(0, hashIndex) : href
		if (titleOrPath.includes("/")) {
			titleOrPath = titleOrPath.concat(".md")
		}

		// Grab the route and make either a page link or an img API call
		if (routes.getRoute(titleOrPath)) {
			const route = routes.getRoute(titleOrPath) as string
			const sub =
				hashIndex > -1
					? `/wiki/${route}${href.substring(hashIndex)}`
					: `/wiki/${route}`
			link.setAttribute("href", sub)
		} else if (imageNameToPath.has(titleOrPath)) {
			const slug = imageNameToPath.get(titleOrPath) as string
			const path = encodeURIComponent(slug)
			link.setAttribute("href", `/api/image/${path}`)
		} else {
			// If no slug is found, unwrap the anchor tag
			const parent = link.parentNode
			while (link.firstChild) {
				parent?.insertBefore(link.firstChild, link)
			}
			parent?.removeChild(link)
		}
	}

	// Unwrap nested images and Excalidraw drawings to be top-level img elements
	const nestedImgs = Array.from(
		doc.querySelectorAll("p > span.image-embed > img")
	)
	for (const img of nestedImgs) {
		const span = img.parentElement
		const p = span?.parentElement
		if (p && span) {
			p.parentNode?.insertBefore(img, p)
			span.remove()
			p.remove()
		}
	}

	const nestedExcalidraw = Array.from(
		doc.querySelectorAll("div.excalidraw-svg > img")
	)
	for (const img of nestedExcalidraw) {
		const div = img.parentElement
		if (div) {
			div.parentNode?.insertBefore(img, div)
			div.remove()
		}
	}

	// Handle <img> sources and captions
	const imgs = Array.from(doc.querySelectorAll("img"))
	for (const img of imgs) {
		let path: string | undefined
		if (img.classList.contains("excalidraw-embedded-img")) {
			// Excalidraw support. Filesource contains the path
			path = img.getAttribute("filesource")?.replace(/\.md$/, ".svg")
			img.removeAttribute("draggable")
			img.removeAttribute("oncanvas")
			img.removeAttribute("filesource")
		} else {
			// The alt property contains the filename
			const filename = img.getAttribute("alt")
			if (!filename) continue
			path = imageNameToPath.get(filename)
		}

		// Inline :::image::: blocks add their caption as the next element over
		// Frontend uses data-caption to initialize caption, so we move it to there
		const caption = img.nextElementSibling
		if (
			caption &&
			caption.tagName === "P" &&
			caption.classList.contains("image-caption")
		) {
			img.setAttribute("data-caption", caption.innerHTML ?? "")
			img.setAttribute("alt", caption.textContent ?? "")
			caption.remove()
		}

		if (path) {
			const component = encodeURIComponent(path)
			img.setAttribute("src", `/api/image/${component}`)
		} else {
			img.removeAttribute("src")
		}
	}

	// Move data-heading to id on <hN>
	for (const h of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
		const headers = Array.from(doc.querySelectorAll(h))
		for (const header of headers) {
			const id = header.getAttribute("data-heading")
			if (id) header.setAttribute("id", encodeURIComponent(id))
			header.removeAttribute("data-heading")
		}
	}

	// Remove copy code buttons
	doc.querySelectorAll("button.copy-code-button").forEach((btn) =>
		btn.remove()
	)

	// Default code blocks to markdown if language is unspecified (prevents unstyled code blocks)
	const presWithCode = Array.from(doc.querySelectorAll("pre:has(> code)"))
	for (const pre of presWithCode) {
		if (pre.classList.length === 0) {
			pre.className = "language-markdown"
			const code = pre.querySelector("code")
			if (code && code.classList.length === 0) {
				code.className = "language-markdown"
			}
		}
	}

	// Text embeds: Remove empty tags
	doc.querySelectorAll("div.markdown-embed-title").forEach((div) =>
		div.remove()
	)
	doc.querySelectorAll("p:has(> span.markdown-embed)").forEach((p) =>
		p.remove()
	)

	// Text embeds: Change classes
	doc.querySelectorAll("div.markdown-preview-view").forEach(
		(div) => (div.className = "note-embed")
	)

	// Disable checklist checkboxes
	doc.querySelectorAll("input.task-list-item-checkbox").forEach((input) =>
		input.setAttribute("disabled", "")
	)

	// Callout icons are not available in the rendered HTML (probably added by JS after render)
	// so we do the same here (icons are below)
	const callouts = Array.from(doc.querySelectorAll(".callout"))
	for (const callout of callouts) {
		const icon = callout.querySelector(".callout-icon")
		const calloutType = callout.getAttribute("data-callout")
		if (!icon || !calloutType) continue
		const svg = calloutIcons[calloutType]
		if (!svg) continue

		icon.innerHTML = svg
	}

	return doc.body.innerHTML
}

const calloutIcons: Record<string, string> = {
	abstract: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clipboard-list-icon lucide-clipboard-list"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>`,
	attention: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert-icon lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
	bug: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bug-icon lucide-bug"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>`,
	caution: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert-icon lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
	check: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-icon lucide-check"><path d="M20 6 9 17l-5-5"/></svg>`,
	cite: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-quote-icon lucide-quote"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg>`,
	danger: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap-icon lucide-zap"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>`,
	done: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-icon lucide-check"><path d="M20 6 9 17l-5-5"/></svg>`,
	error: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap-icon lucide-zap"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>`,
	fail: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
	failure: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
	faq: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
	help: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
	hint: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flame-icon lucide-flame"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
	important: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flame-icon lucide-flame"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
	info: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info-icon lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
	example: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list-icon lucide-list"><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/></svg>`,
	missing: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
	question: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
	quote: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-quote-icon lucide-quote"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg>`,
	success: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-icon lucide-check"><path d="M20 6 9 17l-5-5"/></svg>`,
	tip: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flame-icon lucide-flame"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
	todo: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check-icon lucide-circle-check"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
	warning: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert-icon lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
}
