const github = require('@actions/github')
const core = require('@actions/core')
const _ = require('lodash')
// import cc from '@conventional-commits/parser'

// const types = [
//   { types: ['feat', 'feature'], header: 'New Features', icon: ':sparkles:' },
//   { types: ['fix', 'bugfix'], header: 'Bug Fixes', icon: ':bug:' },
//   { types: ['perf'], header: 'Performance Improvements', icon: ':zap:' },
//   { types: ['refactor'], header: 'Refactors', icon: ':recycle:' },
//   { types: ['test', 'tests'], header: 'Tests', icon: ':white_check_mark:' },
//   { types: ['build', 'ci'], header: 'Build System', icon: ':construction_worker:' },
//   { types: ['doc', 'docs'], header: 'Documentation Changes', icon: ':memo:' },
//   { types: ['style'], header: 'Code Style Changes', icon: ':art:' },
//   { types: ['chore'], header: 'Chores', icon: ':wrench:' },
//   { types: ['other'], header: 'Other Changes', icon: ':flying_saucer:' }
// ]

// const rePrId = /#([0-9]+)/g
// const rePrEnding = /\(#([0-9]+)\)$/

// const buildSubject = ({ subject, author, authorUrl, owner, repo }) => {
//   const hasPR = rePrEnding.test(subject)
//   let final = subject
//
//   if (hasPR) {
//     const prMatch = subject.match(rePrEnding)
//     const msgOnly = subject.slice(0, prMatch[0].length * -1)
//     final = msgOnly.replace(rePrId, (m, prId) => {
//       return `[#${prId}](https://github.com/${owner}/${repo}/pull/${prId})`
//     })
//     final += `*(PR [#${prMatch[1]}](https://github.com/${owner}/${repo}/pull/${prMatch[1]}) by [@${author}](${authorUrl}))*`
//   } else {
//     final = subject.replace(rePrId, (m, prId) => {
//       return `[#${prId}](https://github.com/${owner}/${repo}/pull/${prId})`
//     })
//     final += ` *(commit by [@${author}](${authorUrl}))*`
//   }
//
//   return final
// }

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
    return core.setFailed('Couldn\'t find any commits between latest and previous tags.')
  }

  // PARSE COMMITS

  const commitsParsed = []

  for (const commit of commits) {
    try {
      // const cAst = cc.toConventionalChangelogFormat(cc.parser(commit.commit.message))
      commitsParsed.push({
        message: commit.commit.message,
        sha: commit.sha,
        url: commit.html_url,
        author: commit.author.login,
        authorUrl: commit.author.html_url
      })
      // for (const note of cAst.notes) {
      //   if (note.title === 'BREAKING CHANGE') {
      //     breakingChanges.push({
      //       sha: commit.sha,
      //       url: commit.html_url,
      //       subject: cAst.subject,
      //       author: commit.author.login,
      //       authorUrl: commit.author.html_url,
      //       text: note.text
      //     })
      //   }
      // }
      core.info(`[OK] Commit ${commit.sha}`)
    } catch (err) {
      core.info(`[INVALID] Skipping commit ${commit.sha} as it doesn't follow conventional commit format.`)
    }
  }

  if (commitsParsed.length < 1) {
    return core.setFailed('No valid commits parsed since previous tag.')
  }

  // BUILD CHANGELOG

  // const changes = []

  // let idx = 0
  // for (const type of types) {
  //   const matchingCommits = commitsParsed.filter(c => type.types.includes(c.type))
  //   if (matchingCommits.length < 1) {
  //     continue
  //   }
  //   if (idx > 0) {
  //     changes.push('')
  //   }
  //   changes.push(`### ${type.icon} ${type.header}`)
  //   for (const commit of matchingCommits) {
  //     const scope = commit.scope ? `**${commit.scope}**: ` : ''
  //     const subject = buildSubject({
  //       subject: commit.subject,
  //       author: commit.author,
  //       authorUrl: commit.authorUrl,
  //       owner,
  //       repo
  //     })
  //     changes.push(`- [\`${commit.sha.substring(0, 7)}\`](${commit.url}) - ${scope}${subject}`)
  //   }
  //   idx++
  // }
  //
  // if (breakingChanges.length > 0) {
  //   changes.push('')
  //   changes.push('### :boom: BREAKING CHANGES')
  //   for (const breakChange of breakingChanges) {
  //     const body = breakChange.text.split('\n').map(ln => `  ${ln}`).join('  \n')
  //     const subject = buildSubject({
  //       subject: breakChange.subject,
  //       author: breakChange.author,
  //       authorUrl: breakChange.authorUrl,
  //       owner,
  //       repo
  //     })
  //     changes.push(`- due to [\`${breakChange.sha.substring(0, 7)}\`](${breakChange.url}) - ${subject}:\n\n${body}\n`)
  //   }
  // } else if (changes.length > 0) {
  //   changes.push('')
  // } else {
  //   return core.warning('Nothing to add to changelog because of excluded types.')
  // }

  core.setOutput('changes', commitsParsed.join('\n'))
}

main().catch(console.error)
