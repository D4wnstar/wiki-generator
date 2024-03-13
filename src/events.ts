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

			const isInSecretFolder = s.secretFolders.some((secretPath) =>
				filepath.startsWith(secretPath)
			)

			if (
				!s.restrictFolders ||
				(isInPublishedFolder && !isInSecretFolder)
			) {
				view.editor.replaceRange(
					"---\nwiki-publish: true\n---\n",
					view.editor.getCursor()
				)
			}
		}
	}, 500)
}
