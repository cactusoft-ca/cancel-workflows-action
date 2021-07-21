/* eslint-disable prettier/prettier */
import * as core from '@actions/core'
import * as github from '@actions/github'

if (!github) {
  throw new Error('Module not found: github')
}

if (!core) {
  throw new Error('Module not found: core')
}

async function main() {
  const {
    eventName,
    sha,
    ref,
    repo: {owner, repo},
    payload
  } = github.context
  const {GITHUB_RUN_ID} = process.env
  core.debug(`GITHUB_RUN_ID ${GITHUB_RUN_ID}`)
  let branch = ref.slice(11)
  core.debug(`GITHUB_RUN_ID ${branch}`)
  let headSha = sha
  core.debug(`headSha ${headSha}`)
  console.log(`payload.pull_request ${JSON.stringify(payload.pull_request)}`)
  console.log(`payload.workflow_run ${JSON.stringify(payload.workflow_run)}`)
  if (payload.pull_request) {
    branch = payload.pull_request.head.ref
    headSha = payload.pull_request.head.sha
  } else if (payload.workflow_run) {
    branch = payload.workflow_run.head_branch
    headSha = payload.workflow_run.head_sha
  }

  console.log({eventName, sha, headSha, branch, owner, repo, GITHUB_RUN_ID})
  const token = core.getInput('github_token', {required: true})
  const workflow_id = core.getInput('workflow_id', {required: false})
  const ignore_sha = core.getInput('ignore_sha', {required: false}) === 'true'
  console.log(`Found token: ${token ? 'yes' : 'no'}`)
  const workflow_ids: string[] = []
  const octokit = github.getOctokit(token)

  const {data: current_run} = await octokit.actions.getWorkflowRun({
    owner,
    repo,
    run_id: Number(GITHUB_RUN_ID)
  })
  console.log(`current_run: ${current_run}`)
  console.log(`workflow_id input: ${workflow_id}`)

  if (workflow_id) {
    // The user provided one or more workflow id
    workflow_id
      .replace(/\s/g, '')
      .split(',')
      .forEach(n => workflow_ids.push(n))
  } else {
    // The user did not provide workflow id so derive from current run
    workflow_ids.push(String(current_run.workflow_id))
  }

  console.log(`Found workflow_id: ${JSON.stringify(workflow_ids)}`)

  await Promise.all(
    workflow_ids.map(async workflow_id => {
      try {
        const {data} = await octokit.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id,
          branch
        })
        core.debug(`listWorkflowRuns: ${JSON.stringify(data)}`)

        const branchWorkflows = data.workflow_runs.filter(function(run) {
          if(current_run?.pull_requests?.length > 0){
            console.log(`current_run.pull_requests ${JSON.stringify(current_run.pull_requests)}`)
            if(run?.id !== current_run?.id &&  run?.pull_requests[0]?.id === current_run?.pull_requests[0]?.id && run?.status !== "completed"){
              return true
            }

            return false
          }
          return false
        })

        core.debug(`Found ${branchWorkflows.length} runs for workflow ${workflow_id} on branch ${branch}`)
        core.debug(branchWorkflows.map(run => `- ${run.html_url}`).join('\n'))

        const runningWorkflows = branchWorkflows.filter(
          run =>
            (ignore_sha || run.head_sha !== headSha) &&
            run.status !== 'completed' &&
            new Date(run.created_at) < new Date(current_run.created_at)
        )

        console.log(`%cwith ${runningWorkflows.length} runs to cancel.`, 'color: green;')

        for (const {id, head_sha, status, html_url} of runningWorkflows) {
          console.log('Canceling run: ', {id, head_sha, status, html_url})
          const res = await octokit.actions.cancelWorkflowRun({
            owner,
            repo,
            run_id: id
          })

          core.debug(`Cancel run ${id} responded with status ${JSON.stringify(res)}`)
        }
      } catch (e) {
        const msg = e.message || e
        core.error(`Error while canceling workflow_id ${workflow_id}: ${msg}`)
      }
      core.debug('')
    })
  )
}

main()
  .then(() => core.info('Cancel Complete.'))
  .catch(e => core.setFailed(e.message))
