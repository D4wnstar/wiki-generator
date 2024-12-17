import { MarkdownView, TFile, Workspace } from "obsidian"
import { WikiGeneratorSettings } from "./settings"

export function addWikiPublishToNewFile(
	file: TFile,
	s: WikiGeneratorSettings,
	workspace: Workspace
) {
	// Timeout is here to let the workspace update before getting the view
	// Half a second seems to make it play well enough with Templater
	setTimeout(() => {
		const view = workspace.getActiveViewOfType(MarkdownView)

		// Check that an editor is selected
		if (view) {
			const filepath = view.file?.path

			// If there is no open file or if the current file is not the one
			// that was just created, ignore it
			// This prevents frontmatter being added when a file is created elsewhere
			// such as when dragging and dropping a file or when pulling from GitHub
			// with the Obsidian git plugin
			if (!filepath || filepath !== file.path) return

			// Check if the file is in a public or private folder
			const isInPublishedFolder = s.publicFolders.some((publicPath) =>
				filepath.startsWith(publicPath)
			)

			const isInPrivateFolder = s.privateFolders.some((privatePath) =>
				filepath.startsWith(privatePath)
			)

			// Only add frontmatter if folders aren't restricted or we're in a valid folder
			if (
				!s.restrictFolders ||
				(isInPublishedFolder && !isInPrivateFolder)
			) {
				view.editor.replaceRange(
					"---\nwiki-publish: true\n---\n",
					view.editor.getCursor()
				)
			}
		}
	}, 500)
}
