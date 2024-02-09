import { MarkdownView, Workspace } from "obsidian"
import { WikiGeneratorSettings } from "./settings"

export function autopublishNotes(
	s: WikiGeneratorSettings,
	workspace: Workspace
) {
	// Timeout is here to let the workspace update before getting the view
	// Half a second seems to make it play well enough with Templater
	setTimeout(() => {
		const view = workspace.getActiveViewOfType(MarkdownView)
		if (s.autopublishNotes && view) {
			const filepath = view.file?.path
			if (!filepath) return

			const isInPublishedFolder = s.publicFolders.some((publicPath) =>
				filepath.startsWith(publicPath)
			)

			const isInPrivateFolder = s.privateFolders.some((privatePath) =>
				filepath.startsWith(privatePath)
			)

			if (
				!s.restrictFolders ||
				(isInPublishedFolder && !isInPrivateFolder)
			) {
				view.editor.replaceRange(
					"---\nwg-publish: true\n---\n",
					view.editor.getCursor()
				)
			}
		}
	}, 500)
}
