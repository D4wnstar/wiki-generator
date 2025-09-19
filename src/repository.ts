import { Notice } from "obsidian"
import { Octokit } from "octokit"
import { createProgressBarFragment } from "./utils"

const TEMPLATE_OWNER = "D4wnstar"
const TEMPLATE_REPO = "wiki-generator-template"
const EXCLUDED_PATHS = ["README.md"]

type File = {
	sha: string
	content?: string
}

export async function pullWebsiteUpdates(
	token: string,
	username: string,
	repo: string,
	options: { overwrite: boolean; dryRun?: boolean }
) {
	const octokit = new Octokit({
		auth: token,
	})

	const { fragment, updateProgress } = createProgressBarFragment()
	const notice = new Notice(fragment, 0)

	try {
		// Get current state of template repo
		updateProgress(5, "Getting template")
		const templateTree = await octokit.request(
			"GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
			{
				owner: TEMPLATE_OWNER,
				repo: TEMPLATE_REPO,
				tree_sha: "main",
				recursive: "true",
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			}
		)

		// Get current state of user repo
		updateProgress(10, "Getting user website")
		const userTree = await octokit.request(
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

		console.debug(
			`Template repo has ${templateTree.data.tree.length} files`
		)
		console.debug(`User repo has ${userTree.data.tree.length} files`)

		updateProgress(20, "Finding different files")
		const diff = diffTrees(
			userTree.data.tree.filter((file) => file.type === "blob"),
			templateTree.data.tree.filter((file) => file.type === "blob")
		)

		// Diff by content and save the content for later
		updateProgress(30, "Finding different content")
		await diffContent(octokit, username, repo, diff.toUpdate)

		// Save the content to create too
		updateProgress(60, "Getting new content")
		await getNewContent(octokit, diff.toCreate)

		console.debug("To create:", diff.toCreate)
		console.debug("To update:", diff.toUpdate)
		console.debug("To delete:", diff.toDelete)

		if (options.dryRun) {
			updateProgress(100, "Dry run completed!")
			setTimeout(() => notice.hide(), 3000)
			return
		}

		let branch: string | undefined
		let commitSha: string | undefined
		if (!options.overwrite) {
			updateProgress(70, "Creating new branch")
			const out = await createBranch(octokit, username, repo)
			branch = out.branch
			commitSha = out.commitSha
		}

		updateProgress(80, "Committing changes")
		await commitChanges(octokit, username, repo, diff, branch)

		if (!options.overwrite) {
			updateProgress(95, "Creating pull request")
			await createPullRequest(
				octokit,
				username,
				repo,
				branch as string,
				commitSha as string
			)
		}

		updateProgress(100, "Update complete!")
		setTimeout(() => notice.hide(), 3000)
	} catch (error) {
		const msg = error.response?.data?.message ?? error.message
		console.error(`Error! Status: ${error.status}. Error message: ${msg}`)
		updateProgress(100, "Update failed. There was an error while updating.")
	}
}

function diffTrees(userTree: any[], templateTree: any[]) {
	const userRepo = new Map<string, string>(
		userTree.map((file) => [file.path, file.sha])
	)
	const templateRepo = new Map<string, string>(
		templateTree.map((file) => [file.path, file.sha])
	)

	for (const ignored of EXCLUDED_PATHS) {
		userRepo.delete(ignored)
		templateRepo.delete(ignored)
	}

	// For the API to modify user files, we need the SHA from the user repo

	// To delete (in user repo but not in template)
	const toDelete = new Map<string, string>()
	for (const [userPath, userSha] of userRepo) {
		if (!templateRepo.has(userPath)) {
			toDelete.set(userPath, userSha)
		}
	}

	// To update (in both repos)
	// To create (in template but not in user repo)
	const toUpdate = new Map<string, File>()
	const toCreate = new Map<string, File>()
	for (const templatePath of templateRepo.keys()) {
		if (userRepo.has(templatePath)) {
			const userSha = userRepo.get(templatePath) as string
			toUpdate.set(templatePath, { sha: userSha })
		} else {
			// API doesn't need a SHA to create a file
			toCreate.set(templatePath, { sha: "" })
		}
	}

	console.debug("User tree", userRepo)
	console.debug("Template tree", templateRepo)
	return { toDelete, toUpdate, toCreate }
}

async function diffContent(
	octokit: Octokit,
	username: string,
	repo: string,
	toUpdate: Map<string, File>
) {
	for (const [filepath, { sha }] of toUpdate) {
		// Get template file content
		const templateFile = await octokit.request(
			"GET /repos/{owner}/{repo}/contents/{path}",
			{
				owner: TEMPLATE_OWNER,
				repo: TEMPLATE_REPO,
				path: filepath,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			}
		)
		const userFile = await octokit.request(
			"GET /repos/{owner}/{repo}/contents/{path}",
			{
				owner: username,
				repo,
				path: filepath,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			}
		)
		// @ts-expect-error
		const templateContent = templateFile.data.content as string
		// @ts-expect-error
		const userContent = userFile.data.content as string

		if (userContent === templateContent) {
			// If file is identical, no need to update it
			toUpdate.delete(filepath)
		} else {
			// If not, save the template's content for later
			toUpdate.set(filepath, { sha, content: templateContent })
			// @ts-expect-error
			console.debug("Found different files:", userFile.data.name)
		}
	}
}

async function getNewContent(octokit: Octokit, toCreate: Map<string, File>) {
	for (const path of toCreate.keys()) {
		const templateFile = await octokit.request(
			"GET /repos/{owner}/{repo}/contents/{path}",
			{
				owner: TEMPLATE_OWNER,
				repo: TEMPLATE_REPO,
				path,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			}
		)
		// @ts-expect-error
		const templateContent = templateFile.data.content as string
		toCreate.set(path, { sha: "", content: templateContent })
	}
}

async function commitChanges(
	octokit: Octokit,
	username: string,
	repo: string,
	diff: {
		toCreate: Map<string, File>
		toUpdate: Map<string, File>
		toDelete: Map<string, string>
	},
	branch?: string
) {
	let deleteCount = 0
	let createCount = 0
	let updateCount = 0
	let errorCount = 0

	// Delete excess files from user repo
	for (const [path, sha] of diff.toDelete) {
		try {
			const res = await octokit.request(
				"DELETE /repos/{owner}/{repo}/contents/{path}",
				{
					owner: username,
					repo,
					path,
					message: `Autoupdate: Delete ${path}`,
					sha,
					branch,
					headers: {
						"X-GitHub-Api-Version": "2022-11-28",
					},
				}
			)
			if (res.status >= 400) {
				throw new Error(`Request errored with status ${res.status}`)
			}

			deleteCount += 1
		} catch (error) {
			errorCount += 1
			console.error(`Failed to delete ${path}:`, error.message)
		}
	}

	// Create new files from template
	for (const [path, { content }] of diff.toCreate) {
		if (!content) {
			console.warn(
				`Couldn't find content for ${path}. This shouldn't happen`
			)
			continue
		}

		try {
			const res = await octokit.request(
				"PUT /repos/{owner}/{repo}/contents/{path}",
				{
					owner: username,
					repo,
					path,
					message: `Autoupdate: Create ${path}`,
					content,
					branch,
					headers: {
						"X-GitHub-Api-Version": "2022-11-28",
					},
				}
			)
			if (res.status >= 400) {
				throw new Error(`Request errored with status ${res.status}`)
			}

			createCount += 1
		} catch (error) {
			errorCount += 1
			console.error(`Failed to create ${path}:`, error.message)
		}
	}

	// Update all files that changed since last update
	for (const [path, { sha, content }] of diff.toUpdate) {
		if (!content) {
			console.warn(
				`Couldn't find content for ${path}. This shouldn't happen`
			)
			continue
		}

		try {
			// Retry up to 3 times for rate limits
			let retries = 3
			while (retries > 0) {
				try {
					const res = await octokit.request(
						"PUT /repos/{owner}/{repo}/contents/{path}",
						{
							owner: username,
							repo,
							path,
							message: `Autoupdate: Update ${path}`,
							content,
							sha,
							branch,
							headers: {
								"X-GitHub-Api-Version": "2022-11-28",
							},
						}
					)
					if (res.status >= 400) {
						throw new Error(
							"Failed to create or overwrite user file with template file"
						)
					}

					updateCount += 1
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

	console.log(
		`Update complete:
- ${createCount} files created
- ${deleteCount} files deleted
- ${updateCount} files updated
- ${errorCount} errors occured`
	)
}

async function createBranch(octokit: Octokit, username: string, repo: string) {
	// Get a reference to the latest user commit to tell GitHub where to branch from
	// progressBar.updateProgress(50, "Getting latest user commit")
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

	// Get a reference to the latest template commit for the branch name
	// progressBar.updateProgress(60, "Getting latest template commit")
	const latestMainCommitOnTemplate = await octokit.request(
		"GET /repos/{owner}/{repo}/git/ref/{ref}",
		{
			owner: TEMPLATE_OWNER,
			repo: TEMPLATE_REPO,
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
	const branchName = `sync-to-commit-${latestTemplateSha.substring(0, 7)}`

	// Finally, actually create the branch
	// progressBar.updateProgress(70, "Creating new branch")
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
	return { branch: branchName, commitSha: latestTemplateSha }
}

async function createPullRequest(
	octokit: Octokit,
	username: string,
	repo: string,
	branch: string,
	commitSha: string
) {
	const res = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
		owner: username,
		repo: repo,
		title: `Sync template to ${commitSha.substring(0, 7)}`,
		body: `Sync with template commit ${TEMPLATE_OWNER}/${TEMPLATE_REPO}@${commitSha}.`,
		head: branch,
		base: "main",
		headers: {
			"X-GitHub-Api-Version": "2022-11-28",
		},
	})
	if (res.status >= 400) {
		throw new Error("Failed to create pull request")
	}
	console.log(`Created pull request at API URL: ${res.data.url}`)

	return res.data.url
}

export async function checkForTemplateUpdates(
	token: string,
	lastUpdated: string
) {
	if (lastUpdated === "") {
		throw new Error(
			"Unknown time of last update. Editing the deploy hook setting might fix this."
		)
	}
	console.debug("User repo was last updated on:", lastUpdated)
	const octokit = new Octokit({
		auth: token,
	})

	// Fetch all template commits since the user last updated their repo through the plugin
	const templateCommitsRes = await octokit.request(
		"GET /repos/{owner}/{repo}/commits",
		{
			owner: TEMPLATE_OWNER,
			repo: TEMPLATE_REPO,
			since: lastUpdated,
			headers: {
				"X-GitHub-Api-Version": "2022-11-28",
			},
		}
	)
	console.debug("Commits since last update:", templateCommitsRes.data)

	return templateCommitsRes.data
}
