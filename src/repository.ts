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

import { randomUUID } from "crypto"
import { Notice } from "obsidian"
import { Octokit } from "octokit"

export async function updateUserRepository(
	token: string,
	username: string,
	repo: string,
	overwrite: boolean
) {
	const templateOwner = "D4wnstar"
	const templateRepo = "wiki-generator-template"

	const octokit = new Octokit({
		auth: token,
	})

	try {
		const userCommitsRes = await octokit.request(
			"GET /repos/{owner}/{repo}/commits",
			{
				owner: username,
				repo: repo,
				headers: {
					"X-GitHub-Api-Version": "2022-11-28",
				},
			}
		)
		const latestUserCommitSha = userCommitsRes.data[0].sha
		// console.log(
		// 	`Success! Rate limit remaining: ${res.headers["x-ratelimit-remaining"]}.`
		// )
		const lastUpdated = userCommitsRes.data[0].commit.committer?.date
		console.log("Last update date:", lastUpdated)

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
		const latestTemplateCommitSha = templateCommitsRes.data[0].sha

		const changedFiles = new Set<string>()
		for (const commitInfo of templateCommitsRes.data) {
			const commitRes = await octokit.request(
				"GET /repos/{owner}/{repo}/commits/{ref}",
				{
					owner: templateOwner,
					repo: templateRepo,
					ref: commitInfo.sha,
					headers: {
						"X-GitHub-Api-Version": "2022-11-28",
					},
				}
			)
			const files = commitRes.data.files
			if (!files) continue
			files.map((file) => changedFiles.add(file.filename))
		}
		console.log("Got list of changed files")

		// Filtering would happen here...

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

		// Remove all files that have been deleted from the template in the list of changed files
		const currentFilesInTemplate = templateTreeRes.data.tree.map(
			(file) => file.path
		)
		const changedFilesNotDeleted: string[] = Array.from(
			changedFiles
		).filter((file) => currentFilesInTemplate.includes(file))

		const fileContents: Map<string, string> = new Map()
		for (const filepath of changedFilesNotDeleted) {
			try {
				const fileGrabRes = await octokit.request(
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
				fileContents.set(filepath, fileGrabRes.data.content)
			} catch (error) {
				console.warn(
					`Error while getting file ${filepath}: ${error.response.data.message}`
				)
			}
		}
		console.log("Got file contents")

		if (overwrite) {
			return await updateAndAddFiles(octokit, username, repo, fileContents)
		} else {
			return await handleBranchSplit(
				octokit,
				username,
				repo,
				templateOwner,
				templateRepo,
				latestUserCommitSha,
				latestTemplateCommitSha,
				fileContents
			)
		}
	} catch (error) {
		console.error(
			`Error! Status: ${error.status}. Error message: ${error.response.data.message}`
		)
		new Notice(`There was an error while updating.`)
	}
}

async function updateAndAddFiles(
	octokit: Octokit,
	username: string,
	repo: string,
	fileContents: Map<string, string>,
	branch: string | undefined = undefined
) {
	// Get the file tree in the user's repo
	const treeRes = await octokit.request(
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

	// Update files in main directly
	for (const [filepath, contents] of fileContents) {
		// Get the SHA of the file to update by matching the path in the tree
		const shaToUpdate = treeRes.data.tree.find(
			(file) => file.path === filepath
		)?.sha
		// Update or create that file in the branch
		await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
			owner: username,
			repo: repo,
			path: filepath,
			message: `Update or create file ${filepath}`,
			content: contents,
			sha: shaToUpdate,
			branch: branch,
			headers: {
				"X-GitHub-Api-Version": "2022-11-28",
			},
		})
	}
}

async function handleBranchSplit(
	octokit: Octokit,
	username: string,
	repo: string,
	templateOwner: string,
	templateRepo: string,
	latestUserCommitSha: string,
	latestTemplateCommitSha: string,
	fileContents: Map<string, string>
) {
	const randomUuid = randomUUID()
	// Create a new branch
	const branchName = `sync-from-template-${randomUuid}`
	await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
		owner: username,
		repo: repo,
		ref: `refs/heads/${branchName}`,
		sha: latestUserCommitSha,
	})
	console.log(`Successfully created branch ${branchName}`)

	await updateAndAddFiles(octokit, username, repo, fileContents, branchName)

	// Create a pull request to merge into main
	const prRes = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
		owner: username,
		repo: repo,
		title: `Sync with template commit ${randomUuid}`,
		body: `Sync with template commit ${templateOwner}/${templateRepo}@${latestTemplateCommitSha}.`,
		head: branchName,
		base: "main",
		headers: {
			"X-GitHub-Api-Version": "2022-11-28",
		},
	})
	console.log(`Created pull request at API URL: ${prRes.data.url}`)

	return prRes.data.url
}
