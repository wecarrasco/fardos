/**
 * Deployment settings for the "Update now" button.
 *
 * The button asks GitHub to run the scraper workflow. That needs a token, which
 * a static page cannot keep secret -- so each person enters their own once and
 * the browser stores it locally. Nothing secret belongs in this file.
 */
export const CONFIG = {
  owner: 'wecarrasco',
  repo: 'fardos',

  /** Workflow filename. Must live on the default branch for dispatch to work. */
  workflow: 'update-index.yml',

  /** Branch the workflow runs from. */
  ref: 'main',

  /** Roughly how long a full scrape takes, used to pace the progress bar. */
  expectedRunSeconds: 200,
};

export const repoUrl = () => `https://github.com/${CONFIG.owner}/${CONFIG.repo}`;
export const actionsUrl = () => `${repoUrl()}/actions/workflows/${CONFIG.workflow}`;
