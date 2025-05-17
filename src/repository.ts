import { Notice } from "obsidian"
import { Octokit } from "octokit"
import { createProgressBarFragment } from "./utils"

const templateOwner = "D4wnstar"
const templateRepo = "wiki-generator-template"
const EXCLUDED_FILES = ["README.md", "package-lock.json"]

/**
 * User repo update flow chart
 * 1. Get date of last commit in user repo
 * 2. Get list of commits since that date in template repo
 * 3. Create list of changed files in commits since then
 * 4. Run that list through a filter (exclude things like README)
 * 5. Fetch contents of all remaining files
 * If user allows blind overwriting:
 *   6. Overwrite files in the user's main branch with the new content
 * Otherwise:
 *   6. Create a new branch in the user's repo
 *   7. Overwrite files in that branch with the new content
 *   8. Create a pull request to merge new branch into main
 *   9. Tell the user to merge the pull request manually
 */
export async function pullWebsiteUpdates(
	token: string,
	username: string,
	repo: string,
	overwrite: boolean
) {
	const octokit = new Octokit({
		auth: token,
	})

	const { fragment, updateProgress } = createProgressBarFragment()
	const notice = new Notice(fragment, 0)

	try {
		// Get current state of template repo
		updateProgress(5, "Getting template")
		const templateTreeRes = await octokit.request(
			"GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
			{
				owner: templateOwner,
				repo: templateRepo,
				tree_sha: "main",
				recursive: "true",
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			}
		)

		// Get current state of user repo
		updateProgress(10, "Getting user website")
		const userTreeRes = await octokit.request(
			"GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
			{
				owner: username,
				repo: repo,
				tree_sha: "main",
				recursive: "true",
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			}
		)

		// Process all files in template (except excluded ones)
		const templateFiles: Map<
			string,
			{ content: string; userSha?: string }
		> = new Map()
		const userFilesToDelete: Set<{ path: string; userSha: string }> =
			new Set()

		const isExcluded = (filepath: string) =>
			EXCLUDED_FILES.some(
				(pattern) =>
					filepath === pattern ||
					(pattern.endsWith("*") &&
						filepath.startsWith(pattern.slice(0, -1)))
			)

		// First collect all template files
		updateProgress(20, "Collecting new or updated files")
		for (const file of templateTreeRes.data.tree) {
			const filepath = file.path
			if (!filepath || file.type !== "file") continue

			// Skip excluded files
			if (isExcluded(filepath)) continue

			try {
				// Get template file content
				const templateFileRes = await octokit.request(
					"GET /repos/{owner}/{repo}/contents/{path}",
					{
						owner: templateOwner,
						repo: templateRepo,
						path: filepath,
						headers: {
							"X-GitHub-Api-Version": "2022-11-28",
						},
					}
				)
				// @ts-expect-error
				const templateContent = templateFileRes.data.content
				// @ts-expect-error
				const templateSha = templateFileRes.data.sha

				// Get SHA of the equivalent file on the user end if it exists
				const userSha = userTreeRes.data.tree.find(
					(file) => file.path === filepath
				)?.sha

				// Only include file if it's new or changed
				if (!userSha || userSha !== templateSha) {
					templateFiles.set(filepath, {
						content: templateContent,
						userSha: userSha, // Store user SHA for update operation
					})
				}
			} catch (error) {
				console.warn(
					`Error getting template file ${filepath}:`,
					error.message
				)
			}
		}

		// Find files in user repo that don't exist in template (and aren't excluded)
		updateProgress(40, "Collecting outdated files")
		for (const file of userTreeRes.data.tree) {
			const filepath = file.path
			if (!filepath || file.type !== "file" || !file.sha) continue

			// Skip excluded files
			if (isExcluded(filepath)) continue

			// Mark for deletion if no longer in template
			if (
				!templateTreeRes.data.tree.find(
					(file) => file.path === filepath
				)
			) {
				userFilesToDelete.add({ path: filepath, userSha: file.sha })
			}
		}

		console.log(
			`Found ${templateFiles.size} files to update and ${userFilesToDelete.size} files to delete`
		)

		if (overwrite) {
			updateProgress(60, "Updating website")
			return await updateAndAddFiles(
				octokit,
				username,
				repo,
				templateFiles,
				userFilesToDelete
			)
		} else {
			return await handleBranchSplit(
				octokit,
				username,
				repo,
				templateFiles,
				userFilesToDelete,
				{ fragment, updateProgress }
			)
		}
	} catch (error) {
		console.error(
			`Error! Status: ${error.status}. Error message: ${error.response.data.message}`
		)
		new Notice(`There was an error while updating.`)
	} finally {
		updateProgress(100, "Update complete!")
		setTimeout(() => notice.hide(), 3000)
	}
}

async function updateAndAddFiles(
	octokit: Octokit,
	username: string,
	repo: string,
	templateFiles: Map<string, { content: string; userSha?: string }>,
	userFilesToDelete: Set<{ path: string; userSha: string }>,
	branch: string | undefined = undefined
) {
	let successCount = 0
	let deleteCount = 0
	let errorCount = 0

	// First delete files that shouldn't exist anymore
	for (const { path, userSha: sha } of userFilesToDelete) {
		try {
			// Delete the file with the given path and the correct user SHA (NOT the template SHA)
			const deleteRes = await octokit.request(
				"DELETE /repos/{owner}/{repo}/contents/{path}",
				{
					owner: username,
					repo,
					path,
					message: `Remove ${path} (no longer in template)`,
					sha,
					branch,
					headers: {
						"X-GitHub-Api-Version": "2022-11-28",
					},
				}
			)
			if (deleteRes.status >= 400) {
				throw new Error(`Failed to delete ${path} from user repo`)
			}

			deleteCount += 1
		} catch (error) {
			errorCount += 1
			console.error(`Failed to delete ${path}:`, error.message)
		}
	}

	// Then update/create all files from template
	for (const [path, { content, userSha: sha }] of templateFiles) {
		try {
			// Retry up to 3 times for rate limits
			let retries = 3
			while (retries > 0) {
				try {
					// As a reminder, the SHAs in the template file are from the USER REPO just so they work here
					// If a SHA is undefined, that just means that the file does not exist user side and that's fine
					// since the API only needs SHA for overwriting
					const putRes = await octokit.request(
						"PUT /repos/{owner}/{repo}/contents/{path}",
						{
							owner: username,
							repo,
							path,
							message: `Update from template: ${path}`,
							content,
							sha,
							branch,
							headers: {
								"X-GitHub-Api-Version": "2022-11-28",
							},
						}
					)
					if (putRes.status >= 400) {
						throw new Error(
							"Failed to create or overwrite user file with template file"
						)
					}

					successCount += 1
					break
				} catch (error) {
					retries -= 1
					if (retries > 0) {
						console.warn(
							`Error on file update, waiting 5 seconds before retrying`
						)
						await new Promise((resolve) =>
							setTimeout(resolve, 5000)
						)
					} else {
						throw error
					}
				}
			}
		} catch (error) {
			errorCount += 1
			console.error(`Failed to update ${path}:`, error.message)
		}
	}

	// new Notice(
	// 	`Updated ${successCount} files, deleted ${deleteCount}. ${errorCount} errors.`
	// )
	console.log(
		`Update complete: ${successCount} successful, ${deleteCount} deletions, ${errorCount} errors`
	)
}

async function handleBranchSplit(
	octokit: Octokit,
	username: string,
	repo: string,
	templateFiles: Map<string, { content: string; userSha?: string }>,
	userFilesToDelete: Set<{ path: string; userSha: string }>,
	progressBar: {
		fragment: DocumentFragment
		updateProgress: (percent: number, text: string) => void
	}
) {
	// Create a new branch from the latest main commit in user repo
	// First get the reference to the latest commit on user for the SHA
	new Notice("Creating a new branch...")
	progressBar.updateProgress(50, "Getting latest user commit")
	const latestMainCommitOnUser = await octokit.request(
		"GET /repos/{owner}/{repo}/git/ref/{ref}",
		{
			owner: username,
			repo,
			ref: "heads/main",
			headers: {
				"X-GitHub-Api-Version": "2022-11-28",
			},
		}
	)
	if (latestMainCommitOnUser.status >= 400) {
		throw new Error("Failed to get reference to latest user commit")
	}
	const latestUserSha = latestMainCommitOnUser.data.object.sha

	// Then get the reference to the latest commit on template for the branch name
	progressBar.updateProgress(60, "Getting latest template commit")
	const latestMainCommitOnTemplate = await octokit.request(
		"GET /repos/{owner}/{repo}/git/ref/{ref}",
		{
			owner: templateOwner,
			repo: templateRepo,
			ref: "heads/main",
			headers: {
				"X-GitHub-Api-Version": "2022-11-28",
			},
		}
	)
	if (latestMainCommitOnTemplate.status >= 400) {
		throw new Error("Failed to get reference to latest template commit")
	}
	const latestTemplateSha = latestMainCommitOnTemplate.data.object.sha
	const latestTemplateShaShort = latestTemplateSha.substring(0, 7)
	const branchName = `sync-from-template-${latestTemplateShaShort}`

	// Finally, actually create the branch
	progressBar.updateProgress(70, "Creating new branch")
	const branchRes = await octokit.request(
		"POST /repos/{owner}/{repo}/git/refs",
		{
			owner: username,
			repo,
			ref: `refs/heads/${branchName}`,
			sha: latestUserSha,
		}
	)
	if (branchRes.status >= 400) {
		throw new Error("Failed to create branch for template update")
	}
	console.log(`Successfully created branch ${branchName}`)

	// Push all changes to the branch
	progressBar.updateProgress(80, "Adding changes to new branch")
	await updateAndAddFiles(
		octokit,
		username,
		repo,
		templateFiles,
		userFilesToDelete,
		branchName
	)

	// Create a pull request to merge into main
	progressBar.updateProgress(90, "Creating a pull request")
	const prRes = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
		owner: username,
		repo: repo,
		title: `Sync template to ${latestTemplateShaShort}`,
		body: `Sync with template commit ${templateOwner}/${templateRepo}@${latestTemplateSha}.`,
		head: branchName,
		base: "main",
		headers: {
			"X-GitHub-Api-Version": "2022-11-28",
		},
	})
	if (prRes.status >= 400) {
		throw new Error("Failed to create PR for template update")
	}
	console.log(`Created pull request at API URL: ${prRes.data.url}`)

	return prRes.data.url
}

export async function checkForTemplateUpdates(
	username: string,
	repo: string,
	token: string
) {
	const octokit = new Octokit({
		auth: token,
	})

	// Fetch most recent user commit on main branch
	const latestUserCommitRes = await octokit.request(
		"GET /repos/{owner}/{repo}/commits/{ref}",
		{
			owner: username,
			repo,
			ref: "HEAD",
			headers: {
				"X-GitHub-Api-Version": "2022-11-28",
			},
		}
	)
	const lastUpdated = latestUserCommitRes.data.commit.committer?.date
	console.log("User repo was last updated on:", lastUpdated)

	// Fetch all template commits since the user last updated their repo
	const templateCommitsRes = await octokit.request(
		"GET /repos/{owner}/{repo}/commits",
		{
			owner: templateOwner,
			repo: templateRepo,
			since: lastUpdated,
			headers: {
				"X-GitHub-Api-Version": "2022-11-28",
			},
		}
	)

	if (templateCommitsRes.data.length === 0) {
		return undefined
	} else {
		return {
			latestUserCommit: latestUserCommitRes.data,
			newTemplateCommits: templateCommitsRes.data,
		}
	}
}
