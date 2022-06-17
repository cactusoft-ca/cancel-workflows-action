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
    repo: { owner, repo },
    payload
  } = github.context
  const { GITHUB_RUN_ID } = process.env
  core.debug(`GITHUB_RUN_ID ${GITHUB_RUN_ID}`)
  let branch = ref.slice(11)
  core.debug(`GITHUB_RUN_ID ${branch}`)
  let headSha = sha
  core.debug(`headSha ${headSha}`)
  // core.debug(`payload.pull_request ${JSON.stringify(payload.pull_request)}`)
  // core.debug(`payload.workflow_run ${JSON.stringify(payload.workflow_run)}`)
  if (payload.pull_request) {
    branch = payload.pull_request.head.ref
    headSha = payload.pull_request.head.sha
  } else if (payload.workflow_run) {
    branch = payload.workflow_run.head_branch
    headSha = payload.workflow_run.head_sha
  }

  core.debug(`${{ eventName, sha, headSha, branch, owner, repo, GITHUB_RUN_ID }}`)
  const token = core.getInput('github_token', { required: true })
  const workflow_id = core.getInput('workflow_id', { required: false })
  const wait_for_job = core.getInput('wait_for_job', { required: false })
  core.debug(`wait_for_job ${wait_for_job}`)
  const ignore_sha = core.getInput('ignore_sha', { required: false }) === 'true'
  core.debug(`Found token: ${token ? 'yes' : 'no'}`)
  const workflow_ids: string[] = []
  const octokit = github.getOctokit(token)

  const { data: current_run } = await octokit.actions.getWorkflowRun({
    owner,
    repo,
    run_id: Number(GITHUB_RUN_ID)
  })
  core.debug(`current_run: ${JSON.stringify({ current_run_id: current_run.id })}`)
  core.debug(`workflow_id input: ${workflow_id}`)

  if (workflow_id) {
    // The user provided one or more workflow id
    const ids = workflow_id.replace(/\s/g, '').split(',')
    for (const id of ids) {
      workflow_ids.push(id)
    }
  } else {
    // The user did not provide workflow id so derive from current run
    workflow_ids.push(String(current_run.workflow_id))
  }

  core.debug(`Found workflow_id: ${JSON.stringify(workflow_ids)}`)

  await Promise.all(
    workflow_ids.map(async id => {
      try {
        const { data } = await octokit.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id: id,
          branch
        })
        core.debug(`Workflow runs (${data.total_count}): ${JSON.stringify(data.workflow_runs.map(m => ({ id: m.id, conclusion: m.conclusion, status: m.status })))}`)

        const branchWorkflows = data.workflow_runs.filter(function (run) {
          if (!current_run) return
          if (!current_run.pull_requests) return
          if (current_run.pull_requests.length === 0) return
          const firstPr = current_run.pull_requests[0]

          if (!run) return
          if (!run.pull_requests) return
          if (run.pull_requests.length === 0) return

          // core.debug(`current_run.pull_requests ${JSON.stringify(firstPr)}`)

          if (
            run?.id !== current_run?.id &&
            run?.pull_requests[0].id === firstPr.id &&
            run?.status !== 'completed'
          ) {
            return true
          }

          return false
        })

        core.debug(
          `Found ${branchWorkflows.length} runs for workflow ${id} on branch ${branch}`
        )
        core.debug(branchWorkflows.map(run => `- ${run.html_url}`).join('\n'))

        const runningWorkflows = branchWorkflows.filter(
          run =>
            (ignore_sha || run.head_sha !== headSha) &&
            run.status !== 'completed' &&
            new Date(run.created_at) < new Date(current_run.created_at)
        )

        core.debug(`with ${runningWorkflows.length} runs to cancel.`)

        // for each running workflows get the jobs that are in progress
        const jobs = await Promise.all(
          runningWorkflows.map(async run => {
            const {
              data: jobData
            } = await octokit.actions.listJobsForWorkflowRun({
              owner,
              repo,
              run_id: run.id
            })
            core.debug(`Jobs status from running workflows: ${JSON.stringify(jobData.jobs.filter(job => job.name === wait_for_job).map(job => ({ jobName: job.name, jobStatus: job.status })))}`)
            // JSON.stringify(jobData.jobs.filter(job => job.name === wait_for_job))
            return jobData.jobs
          })
        )

        // get all jobs that are in progress with job name equals de wait_for_job and that are in_progress
        const jobsToCancel = jobs.reduce((acc, cur) => {
          return acc.concat(cur.filter(job => job.name === wait_for_job && job.status === 'in_progress'))
        }
          , [])

        const jobToCancel = jobsToCancel.length ? jobsToCancel[0] : undefined

        if (jobToCancel) {
          let jobStatus = jobToCancel.status
          while (jobStatus === 'in_progress') {
            core.debug(`Waiting for job ${jobToCancel.id} to complete`)
            await new Promise(resolve => setTimeout(resolve, 10000))

            const {
              data: jobData
            } = await octokit.actions.getJobForWorkflowRun({
              owner,
              repo,
              job_id: jobToCancel.id
            })

            jobStatus = jobData.status
            core.debug(`Job ${jobData.id} status: ${jobData.status}`)
          }

          core.debug(`Job ${wait_for_job} completed`)
        }

        for (const {
          id: runningWorkflowId,
          head_sha,
          status,
          html_url
        } of runningWorkflows) {
          core.debug(
            `Canceling run: ${JSON.stringify({
              id: runningWorkflowId,
              head_sha,
              status,
              html_url
            })}`
          )
          const res = await octokit.actions.cancelWorkflowRun({
            owner,
            repo,
            run_id: runningWorkflowId
          })

          core.debug(
            `Cancel run ${runningWorkflowId} responded with status ${JSON.stringify(
              res
            )}`
          )
        }
      } catch (e) {
        const msg = e.message || e
        core.error(`Error while canceling workflow_id ${id}: ${msg}`)
      }
      core.debug('')
    })
  )
}

main()
  .then(() => core.info('Cancel Complete.'))
  .catch(e => core.setFailed(e.message))
