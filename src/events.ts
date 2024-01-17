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
			const fileFolder = view.file?.path.match(/.*(?=\/)/)?.[0]
            if (!fileFolder) return

			const isInPublishedFolder = s.publishedFolders.some((path) =>
				fileFolder.includes(path)
			)
			
            if (!s.restrictFolders || isInPublishedFolder) {
				view.editor.replaceRange(
					"---\nwg-publish: true\n---\n",
					view.editor.getCursor()
				)
			}
		}
	}, 500)
}
