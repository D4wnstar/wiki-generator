import { App, TFile } from "obsidian"
import { slugPath } from "src/utils"
import { handleCustomSyntax } from "./custom-blocks"
import { Frontmatter, Note, Page } from "../database/types"
import { md2html } from "src/commands"

export async function createPage(
	file: TFile,
	hash: string,
	titleToSlug: Map<string, string>,
	imageNameToPath: Map<string, string>,
	app: App
): Promise<Page | null> {
	const content = await app.vault.cachedRead(file)
	const frontmatter = await extractFrontmatter(content)

	// Anything that's not public should me marked as such to keep thing synced
	if (!frontmatter["wiki-publish"]) return null

	// Parse and replace custom :::blocks::: and other non-standard syntax
	const { md, details, sidebarImages } = await handleCustomSyntax(
		content,
		file.name,
		app,
		imageNameToPath
	)

	// Convert the entire markdown to HTML using Obsidian's builtin renderer
	const html = await md2html(md, app)

	// Get aliases as search terms
	const title = file.basename
	const alt_title = frontmatter["wiki-title"] ?? null
	const aliases = frontmatter["aliases"]?.join("; ") as string | undefined
	let search_terms = title
	search_terms += alt_title ? `; ${alt_title}` : ""
	search_terms += aliases ? `; ${aliases}` : ""

	// A page can be prerendered if it does not depend on user permission
	const allowed_users = frontmatter["wiki-allowed-users"]?.join("; ") ?? null

	const note: Note = {
		title,
		alt_title,
		search_terms,
		path: file.path,
		slug: titleToSlug.get(title) ?? slugPath(file.path),
		frontpage: frontmatter["wiki-home"] ?? 0,
		lead: "", // Currently unused, needed for popups once they are reimplemented
		allowed_users,
		hash,
		last_updated: Math.floor(Date.now() / 1000),
		can_prerender: Number(!allowed_users),
		html_content: html,
	}

	return {
		note,
		details,
		sidebarImages,
	}
}

/**
 * Extract frontmatter from markdown content
 * @param content The markdown content
 * @returns The frontmatter object
 */
async function extractFrontmatter(content: string): Promise<Frontmatter> {
	// Simple frontmatter extraction
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/
	const match = content.match(frontmatterRegex)

	if (match) {
		const frontmatterContent = match[1]
		const frontmatter: Frontmatter = {} as Frontmatter

		// Parse each line
		const lines = frontmatterContent.split("\n")
		for (const line of lines) {
			const [key, ...valueParts] = line.split(":")
			const value = valueParts.join(":").trim()

			if (key && value) {
				// Handle boolean values
				if (value === "true") {
					frontmatter[key.trim() as keyof Frontmatter] = true as any
				} else if (value === "false") {
					frontmatter[key.trim() as keyof Frontmatter] = false as any
				} else if (value.startsWith("[") && value.endsWith("]")) {
					// Handle array values
					const arrayContent = value.substring(1, value.length - 1)
					frontmatter[key.trim() as keyof Frontmatter] = arrayContent
						.split(",")
						.map((item) => item.trim()) as any
				} else {
					// Handle string values
					frontmatter[key.trim() as keyof Frontmatter] = value as any
				}
			}
		}

		return frontmatter
	}

	return {} as Frontmatter
}

export function postprocessHtml(
	html: string,
	titleToPath: Map<string, string>
) {
	const parser = new DOMParser()
	const doc = parser.parseFromString(html, "text/html")

	// Process each link in reverse order to handle unwrapping correctly
	const links = Array.from(doc.querySelectorAll("a")).reverse()
	for (const link of links) {
		const href = link.getAttribute("href")
		if (!href) continue

		// Remove target="_blank" and data-href
		link.removeAttribute("target")
		link.removeAttribute("data-href")

		// Leave internal links alone
		if (href.startsWith("#")) continue

		// For links to other pages, try to resolve the slug
		// Remove any hash fragment for lookup
		const hashIndex = href.indexOf("#")
		const pageKey = hashIndex > -1 ? href.substring(0, hashIndex) : href

		if (titleToPath.has(pageKey)) {
			const slug = titleToPath.get(pageKey)
			const sub =
				hashIndex > -1
					? `/${slug}${href.substring(hashIndex)}`
					: `/${slug}`
			link.setAttribute("href", sub)
		} else {
			// If no slug is found, unwrap the anchor tag
			const parent = link.parentNode
			while (link.firstChild) {
				parent?.insertBefore(link.firstChild, link)
			}
			parent?.removeChild(link)
		}

		// TODO: Copy data-heading to id
	}

	return doc.body.innerHTML
}
