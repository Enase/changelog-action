const github = require('@actions/github')
const core = require('@actions/core')
const _ = require('lodash')

const createJiraLink = (jiraTicket) => {
  return `https://gosource.atlassian.net/browse/${jiraTicket}`
}

const getPullRequestTitle = async (gh, owner, repo, prNumber) => {
  const { data: pullRequest } = await gh.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber
  })

  return pullRequest.title
}

const titleRegexp = /(?<jiraticket>^GS-\d+):?(\s)+(?<subject>.+)/

const isValidCommitTitle = (title) => {
  return titleRegexp.test(title)
}

const getJiraTicket = (message) => {
  const match = message.match(titleRegexp)
  if (!match) {
    throw Error(`Cannot match jira ticket from: "${message}"`)
  }
  return match.groups.jiraticket
}

const getSubject = (message) => {
  const match = message.match(titleRegexp)
  if (!match) {
    throw Error(`Cannot match subject from: "${message}"`)
  }
  return match.groups.subject || ''
}

const prepareSlackTitle = (messageData) => {
  const subject = getSubject(messageData.message).replaceAll("'", '')
  return [
    `<${createJiraLink(messageData.jiraTicket)}|${messageData.jiraTicket}>: ${subject}`,
    '|',
    `<${messageData.url}|${messageData.sha.slice(0, 6)}>`,
    `by <${messageData.authorUrl}|${messageData.author}>`
  ].join(' ')
}

const main = async () => {
  core.setOutput('failed', false) // mark the action not failed by default
  const token = core.getInput('token')
  const tag = core.getInput('tag')
  const gh = github.getOctokit(token)
  const owner = github.context.repo.owner
  const repo = github.context.repo.repo

  // GET LATEST + PREVIOUS TAGS

  const tagsRaw = await gh.graphql(`
    query lastTags ($owner: String!, $repo: String!) {
      repository (owner: $owner, name: $repo) {
        refs(first: 2, refPrefix: "refs/tags/", orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
          nodes {
            name
            target {
              oid
            }
          }
        }
      }
    }
  `, {
    owner,
    repo
  })

  const latestTag = _.get(tagsRaw, 'repository.refs.nodes[0]')
  const previousTag = _.get(tagsRaw, 'repository.refs.nodes[1]')

  if (!latestTag) {
    return core.setFailed('Couldn\'t find the latest tag. Make sure you have an existing tag already before creating a new one.')
  }
  if (!previousTag) {
    return core.setFailed('Couldn\'t find a previous tag. Make sure you have at least 2 tags already (current tag + previous initial tag).')
  }

  if (latestTag.name !== tag) {
    return core.setFailed('Provided tag doesn\'t match latest tag.')
  }

  core.info(`Using latest tag: ${latestTag.name}`)
  core.info(`Using previous tag: ${previousTag.name}`)

  // GET COMMITS

  let curPage = 0
  let totalCommits = 0
  let hasMoreCommits = false
  const commits = []
  do {
    hasMoreCommits = false
    curPage++
    const commitsRaw = await gh.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${previousTag.name}...${latestTag.name}`,
      page: curPage,
      per_page: 100
    })
    totalCommits = _.get(commitsRaw, 'data.total_commits', 0)
    const rangeCommits = _.get(commitsRaw, 'data.commits', [])
    commits.push(...rangeCommits)
    if ((curPage - 1) * 100 + rangeCommits.length < totalCommits) {
      hasMoreCommits = true
    }
  } while (hasMoreCommits)

  if (!commits || commits.length < 1) {
    core.setOutput('changelog', JSON.stringify('No changes found since previous tag.'))
    return
  }

  // PARSE COMMITS

  const commitsParsed = []

  for (const commit of commits) {
    try {
      const [message] = commit.commit.message.split('\n')
      if (isValidCommitTitle(message)) {
        let subject = message
        const prNumberMatch = getSubject(message).match(/\(#(?<prnumber>\d+)\)/)
        if (prNumberMatch) {
          const prNumber = prNumberMatch.groups.prnumber
          subject = await getPullRequestTitle(gh, owner, repo, prNumber)
        }

        commitsParsed.push({
          message: subject,
          jiraTicket: getJiraTicket(subject),
          sha: commit.sha,
          url: commit.html_url,
          author: commit.author.login,
          authorUrl: commit.author.html_url
        })
      }
      core.info(`[OK] Commit ${commit.sha}`)
    } catch (err) {
      core.info(`[INVALID] Skipping commit ${commit.sha} as it doesn't follow conventional commit format.`)
    }
  }

  if (commitsParsed.length < 1) {
    core.setOutput('changelog', JSON.stringify('No changes found since previous tag.'))
    return
  }

  // BUILD CHANGELOG

  const commitsParsedUnique = _.uniqBy(commitsParsed, 'jiraTicket')

  const changes = [`*Changes deployed in ${latestTag.name}:*`, ...commitsParsedUnique.map((parsedCommit) => {
    return prepareSlackTitle(parsedCommit)
  })]

  core.setOutput('changelog', JSON.stringify(changes.join('\n')))
}

main().catch(console.error)
