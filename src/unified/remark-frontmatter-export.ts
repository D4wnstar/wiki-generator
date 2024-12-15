import type { Node } from "unist"
import { VFile } from "vfile"
import { matter } from "vfile-matter"

/**
 * Barebones remark plugin that exports frontmatter gathered by
 * remarkFrontmatter to `file.data.matter`.
 */
export default function remarkFrontmatterExport() {
	return function (_tree: Node, file: VFile) {
		matter(file)
	}
}
