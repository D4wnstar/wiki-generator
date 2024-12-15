import { visit } from "unist-util-visit"
import type { Root } from "hast"

/**
 * Add Tailwind classes to some unstyled HTML tags.
 */
export default function rehypeStylist() {
	return function (tree: Root) {
		visit(tree, "element", (node) => {
			const oldClass = node.properties.className
			const setClass = (cls: string) =>
				oldClass ? oldClass + ` ${cls}` : cls

			switch (node.tagName) {
				// case "p":
				// 	node.properties.class = setClass("break-words")
				// 	break
				case "a":
					node.properties.className = setClass("anchor")
					// node.properties.target = '_blank'
					break
				case "h1":
					node.properties.className = setClass("h1")
					break
				case "h2":
					node.properties.className = setClass("h2")
					break
				case "h3":
					node.properties.className = setClass("h3")
					break
				case "h4":
					node.properties.className = setClass("h4")
					break
				case "h5":
					node.properties.className = setClass("h5")
					break
				case "h6":
					node.properties.className = setClass("h6")
					break
				case "blockquote":
					node.properties.className = setClass("blockquote")
					break
				case "ul":
					node.properties.className = setClass(
						"list-inside list-disc indent-cascade"
					)
					break
				case "ol":
					node.properties.className = setClass(
						"list-inside list-decimal indent-cascade"
					)
					break
				case "code":
					if (node.properties.className === undefined) {
						node.properties.className = setClass("code")
					}
					break
				case "th":
					node.properties.className = setClass("table-cell")
					break
				case "td":
					node.properties.className = setClass("table-cell")
					break
				default:
					break
			}
		})
	}
}
