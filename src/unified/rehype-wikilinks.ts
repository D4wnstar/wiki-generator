import { slug } from "github-slugger"
import type { Element, ElementContent, Root } from "hast"
import { h } from "hastscript"
import { wikilinkRegex } from "src/notes/regexes"
import { slugPath } from "src/utils"
import { partition } from "src/utils"
import { visit } from "unist-util-visit"

// Capture groups:
//  0. ! (Transclusion or not)
//  1. Linked page title
//  2. Internal header
//  3. Alias

export default function rehypeWikilinks(
	titleToPath: Map<string, string>,
	imageNameToPath: Map<string, string>
) {
	return function (tree: Root) {
		visit(tree, "element", (e) =>
			handleElement(e, titleToPath, imageNameToPath)
		)
	}
}

function handleElement(
	elem: Element,
	titleToPath: Map<string, string>,
	imageNameToPath: Map<string, string>
) {
	// Ignore empty blocks and also code and pre blocks
	if (
		elem.children.length === 0 ||
		elem.tagName === "code" ||
		elem.tagName === "pre"
	) {
		return
	}

	// Process all text children
	for (let i = elem.children.length - 1; i >= 0; i--) {
		const child = elem.children[i]
		// Ignore anything that's not text
		if (child.type !== "text") continue

		const text = child.value
		if (!text.match(wikilinkRegex)) continue

		// Split text into parts separated by wikilinks
		const parts = partition(text, wikilinkRegex)
		const newChildren: ElementContent[] = []
		let hasWikilink = false

		for (const part of parts) {
			if (!part.matched) {
				// Anything that didn't match is just normal text
				newChildren.push({
					type: "text",
					value: part.text,
				})
			} else {
				hasWikilink = true
				const props = findWikilinkProperties(
					part.text,
					titleToPath,
					imageNameToPath
				)
				// If the wikilink is to be removed, just keep the text
				// otherwise add an anchor tag
				newChildren.push(
					props.remove
						? {
								type: "text",
								value: props.linkText,
						  }
						: h("a", { class: props.class, href: props.href }, [
								props.linkText,
						  ])
				)
			}
		}

		if (hasWikilink) {
			// Replace original text node with processed nodes
			elem.children.splice(i, 1, ...newChildren)
		}
	}
}

type Wikilink = {
	linkText: string
	href: string
	class: string
	remove: boolean
}

function findWikilinkProperties(
	link: string,
	titleToPath: Map<string, string>,
	imageNameToPath: Map<string, string>
): Wikilink {
	const rmatch = [...link.matchAll(wikilinkRegex)].at(0)
	if (!rmatch) {
		return {
			linkText: link,
			href: "",
			class: "",
			remove: true,
		}
	}

	const isTransclusion = rmatch[1] === "!"
	const titleOrPath = rmatch[2]
	const header = rmatch[3]
	const alias = rmatch[4]

	const hasFileExtension = titleOrPath.match(/\..*$/)
	if (!isTransclusion) {
		if (!hasFileExtension) {
			return handleTextReference(titleOrPath, header, alias, titleToPath)
		} else {
			return handleImageReference(titleOrPath, imageNameToPath)
		}
	} else {
		// Transclusions are handled separately in the page chunking process
		return { linkText: titleOrPath, href: "", class: "", remove: true }
	}
}

function handleTextReference(
	pageTitleOrPath: string,
	header: string | undefined,
	alias: string | undefined,
	titleToPath: Map<string, string>
): Wikilink {
	const path = pageTitleOrPath.includes("/")
		? slugPath(pageTitleOrPath)
		: titleToPath.get(pageTitleOrPath.toLowerCase())

	const headerLink = header ? `#${slug(header)}` : ""
	const refName = alias?.replace("|", "") ?? pageTitleOrPath

	// If path is not found, that means the note is not published
	// and the link should be remove
	return {
		linkText: refName,
		href: `/${path}${headerLink}`,
		class: "anchor",
		remove: path === undefined,
	}
}

function handleImageReference(
	imageTitleOrPath: string,
	imageNameToPath: Map<string, string>
): Wikilink {
	const imageName = imageTitleOrPath?.includes("/")
		? imageTitleOrPath.split("/").last() ?? ""
		: imageTitleOrPath

	const imagePath = imageNameToPath.get(imageName)
	if (imagePath) {
		return {
			linkText: imageTitleOrPath,
			// NOTE: This won't work if the image is an SVG
			href: `/api/v1/image-blob/${encodeURIComponent(imagePath)}`,
			class: "anchor",
			remove: false,
		}
	} else {
		return {
			linkText: imageTitleOrPath,
			href: "",
			class: "",
			remove: true,
		}
	}
}
