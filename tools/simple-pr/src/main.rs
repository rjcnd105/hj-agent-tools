use anyhow::{Context, Result};
use clap::error::ErrorKind;
use clap::{CommandFactory, Parser, Subcommand};
use futures::future::{join_all, try_join_all};
use regex::Regex;
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::env;
use std::path::PathBuf;
use std::sync::OnceLock;

static JIRA_KEY_REGEX: OnceLock<Regex> = OnceLock::new();

// --- CLI help (에이전트가 --help만 보고 사용할 수 있도록 규칙과 출력 형식을 명시) ---
const ROOT_HELP: &str = "\
Configuration (environment variables, all required):
  BITBUCKET_WORKSPACE  Bitbucket workspace slug
  BITBUCKET_REPO_SLUG  Bitbucket repository slug
  BITBUCKET_API_TOKEN  Bitbucket scoped API token (read:repository, read:pullrequest, write:pullrequest)
  JIRA_HOST            Jira base URL, e.g. https://your-domain.atlassian.net
  JIRA_API_TOKEN       Jira API token
  ATLASSIAN_EMAIL      Atlassian account email, the Basic Auth user for both APIs

  Values are read in this order, and the first one found wins:
    1. Shell environment
    2. .env in the current directory or any parent directory
    3. ~/.config/simple-pr/.env ($XDG_CONFIG_HOME/simple-pr/.env when XDG_CONFIG_HOME is set)
  To target another repository for one call:
    BITBUCKET_REPO_SLUG=other-repo simple-pr bitbucket find --from PROJ-123

Exit status:
  0  Success
  1  Missing configuration, API or network error, or `create` failed for at least one key
  2  Invalid command-line arguments

Examples:
  simple-pr bitbucket find --from PROJ-123                          # read-only
  simple-pr bitbucket create --from PROJ-123 --to dev --dry-run     # read-only preview
  simple-pr bitbucket create --from PROJ-123 --to dev               # opens a PR";

const FIND_HELP: &str = "\
Output (stdout, in --from order):
  🔍 Searching PRs for ...                              first line, progress
  [<KEY>](<JIRA_HOST>/browse/<KEY>) <summary> [PR](<url>) <icon> <STATE> → <destination>    one line per linked Jira issue
  <branch> [PR](<url>) <icon> <STATE> → <destination>   PR has no linked Jira issue
  📭 No PRs found for source branch '<keyword>'          keyword matched nothing

  STATE is OPEN 🟢, MERGED 🟣, DECLINED 🔴 or SUPERSEDED ⚪.
  Linked Jira issues of a PR (a Jira key looks like [A-Z][A-Z0-9_]*-\\d+):
    1. The first key in the source branch name, e.g. feature/PROJ-123-login -> PROJ-123.
    2. If the branch name has no key (e.g. feature/shared-dev), every key in the PR's commit
       messages that exists in Jira, sorted by project and number. Non-issue strings such
       as UTF-8 are dropped, and one PR can print several lines.
  When the lookup for a branch-name key fails, <summary> is \"(Jira Info Failed)\" and a
  warning goes to stderr. Commit-message keys that fail are left out, with a warning.

Examples:
  simple-pr bitbucket find --from PROJ-123
  simple-pr bitbucket find --from PROJ-123 PROJ-124 --to main
  simple-pr bitbucket find --from PROJ-123 --all

See `simple-pr --help` for configuration and exit status.";

const CREATE_HELP: &str = "\
Output (stdout):
  🔍 Finding target branch for '<to>'...
  🎯 Target Branch: <branch>
  Processing <keywords> ...
  ✅ Created: [<source branch>] -> [<target branch>]    one line per key, in --from order
  ❌ Failed: [<keyword>] <error>
  🚀 PR Summary:                                       followed by `find`-style lines for each created PR

  With --dry-run, each key prints this line in place of Created, and no PR is opened:
  🧪 Would create: [<source branch>] -> [<target branch>] <title>

  After every key has been tried, the command exits 1 if any key failed.

Examples:
  simple-pr bitbucket create --from PROJ-123 --to dev --dry-run
  simple-pr bitbucket create --from PROJ-123 --to dev
  simple-pr bitbucket create --from PROJ-123 PROJ-124 --to dev
  simple-pr bitbucket create --from feature/login --to dev --title \"Fix login redirect\"

See `simple-pr --help` for configuration and exit status.";

/// Search and create Bitbucket pull requests from Jira issue keys.
///
/// A PR is linked to the Jira key in its source branch name (e.g. `feature/PROJ-123-login`), or to the Jira keys in its commit messages when the branch name has none (e.g. `feature/shared-dev`). `bitbucket find` is read-only. `bitbucket create` opens PRs on Bitbucket.
#[derive(Parser)]
#[command(name = "simple-pr", version, after_long_help = ROOT_HELP)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Find (read-only) or create Bitbucket PRs for Jira-keyed branches
    ///
    /// `simple-pr bitbucket --from <KEYWORD>... --to <BRANCH>` with no subcommand is shorthand for `create` and opens PRs.
    Bitbucket(BitbucketArgs),
}

#[derive(clap::Args)]
#[command(subcommand_negates_reqs = true)]
struct BitbucketArgs {
    #[command(subcommand)]
    command: Option<BitbucketSubcommands>,

    // --- Create Mode Arguments ---
    /// Shorthand for `create --from` (opens PRs)
    #[arg(long, required = true, num_args = 1..)]
    from: Option<Vec<String>>,
    /// Shorthand for `create --to`
    #[arg(long, required = true)]
    to: Option<String>,
}

#[derive(Subcommand)]
enum BitbucketSubcommands {
    /// Search PRs by source branch keyword and print each one with its linked Jira issues (read-only)
    ///
    /// Each --from keyword is matched against PR source branch names, ignoring case. A match directly followed by a digit is skipped, so `PROJ-12` does not match `PROJ-123`. Open, merged, declined and superseded PRs are all searched (newest 50 per keyword) and printed newest first.
    ///
    /// Only branch names are searched. A Jira key that appears only in commit messages (e.g. PROJ-53 on `feature/shared-dev`) is not a valid --from value: search with the branch name instead, e.g. `--from shared-dev`.
    #[command(after_long_help = FIND_HELP)]
    Find {
        /// Keywords matched against PR source branch names, usually Jira keys (e.g. PROJ-123)
        #[arg(long, required = true, num_args = 1..)]
        from: Vec<String>,

        /// Keep only PRs whose destination branch name contains this text (e.g. main)
        #[arg(long)]
        to: Option<String>,

        /// Output format
        #[arg(long, value_enum, default_value_t = Format::Md)]
        format: Format,

        /// Print every matching PR instead of only the newest one per keyword
        #[arg(long, default_value = "false")]
        all: bool,
    },
    /// Open a PR from each --from branch into the --to branch (writes to Bitbucket)
    ///
    /// Branch resolution, for both --from and --to: a branch whose name equals the keyword wins. Otherwise the first branch Bitbucket returns (up to 100) whose name contains the keyword wins, ignoring case and skipping matches directly followed by a digit. `--to dev` therefore picks `dev` when it exists, else a branch such as `develop`.
    ///
    /// PR title: --title when given. Otherwise `[<KEY>] <Jira summary>`, where KEY is the Jira key in the resolved source branch name. When the Jira lookup fails the title is `[<KEY>] Task <KEY>` and a warning goes to stderr. When the branch name has no Jira key and the branch has exactly one commit that the destination lacks, the title is that commit's subject. Otherwise it is `[<keyword>] Update from <keyword>`. Commit-message keys are not used in the title. They only appear in the PR Summary lines.
    ///
    /// Keys are processed concurrently, and a failure for one key does not stop the others. Use --dry-run to check the resolved branches and title, and `find` to inspect existing PRs.
    #[command(after_long_help = CREATE_HELP)]
    Create {
        /// Keywords that each resolve to one source branch, usually Jira keys (e.g. PROJ-123)
        #[arg(long, required = true, num_args = 1..)]
        from: Vec<String>,
        /// Destination branch name or keyword (e.g. dev)
        #[arg(long, required = true)]
        to: String,
        /// Use this PR title instead of generating one. Allowed with one --from keyword only
        #[arg(long)]
        title: Option<String>,
        /// Resolve branches and title, then print them without opening a PR
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum Format {
    Md,
}

#[derive(Serialize)]
struct CreatePrPayload<'a> {
    title: &'a str,
    source: BranchRef<'a>,
    destination: BranchRef<'a>,
}

#[derive(Serialize)]
struct BranchRef<'a> {
    branch: BranchName<'a>,
}

#[derive(Serialize)]
struct BranchName<'a> {
    name: &'a str,
}

#[derive(Deserialize)]
struct RepoRefResponse {
    values: Vec<RepoBranch>,
}

#[derive(Deserialize)]
struct RepoBranch {
    name: String,
}

#[derive(Deserialize)]
struct RepoPrResponse {
    values: Vec<RepoPr>,
}

#[derive(Deserialize)]
struct RepoPr {
    id: u64,
    state: String,
    links: RepoLinks,
    source: RepoBranchRef,
    destination: RepoBranchRef,
}

#[derive(Deserialize)]
struct RepoCommitResponse {
    values: Vec<RepoCommit>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct RepoCommit {
    message: String,
}

#[derive(Deserialize)]
struct RepoBranchRef {
    branch: RepoBranchName,
}

#[derive(Deserialize)]
struct RepoBranchName {
    name: String,
}

#[derive(Deserialize)]
struct RepoLinks {
    html: RepoLink,
}

#[derive(Deserialize)]
struct RepoLink {
    href: String,
}

#[derive(Deserialize)]
struct JiraIssue {
    fields: JiraFields,
}

#[derive(Deserialize)]
struct JiraFields {
    summary: String,
}

/// PR에 연결된 Jira 이슈 (summary가 None이면 조회 실패)
struct LinkedIssue {
    key: String,
    summary: Option<String>,
}

/// `create`가 키 하나를 처리한 결과
enum KeyOutcome {
    WouldCreate { src_branch: String, title: String },
    Created(RepoPr, Vec<LinkedIssue>),
}

/// 브랜치 이름의 Jira 키 > 유일한 커밋의 제목 > 검색 키워드 순으로 PR 제목을 만듭니다.
fn generated_title(keyword: &str, key: Option<&str>, summary: Option<&str>, commit_subject: Option<&str>) -> String {
    match (key, summary, commit_subject) {
        (Some(key), Some(summary), _) => format!("[{}] {}", key, summary),
        (Some(key), None, _) => format!("[{}] Task {}", key, key),
        (None, _, Some(subject)) => subject.to_string(),
        (None, _, None) => format!("[{}] Update from {}", keyword, keyword),
    }
}

/// 커밋이 정확히 하나일 때 그 메시지의 첫 줄을 반환합니다.
fn sole_commit_subject(page: &RepoCommitResponse) -> Option<&str> {
    match page.values.as_slice() {
        [commit] if page.next.is_none() => commit.message.lines().next().map(str::trim).filter(|s| !s.is_empty()),
        _ => None,
    }
}

fn jira_key_regex() -> &'static Regex {
    JIRA_KEY_REGEX.get_or_init(|| Regex::new(r"[A-Z][A-Z0-9_]*-\d+").unwrap())
}

/// 브랜치 이름에서 첫 번째 Jira 키(예: `PROJ-123`)를 추출합니다.
fn jira_key(branch_name: &str) -> Option<&str> {
    jira_key_regex().find(branch_name).map(|m| m.as_str())
}

/// 여러 텍스트(커밋 메시지 등)에 언급된 Jira 키 후보를 중복 없이 (프로젝트, 번호) 순으로 반환합니다.
fn jira_keys_in<'a>(texts: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut keys: Vec<String> = texts.into_iter()
        .flat_map(|text| jira_key_regex().find_iter(text).map(|m| m.as_str().to_string()))
        .collect();
    keys.sort_by_cached_key(|key| {
        let (project, number) = key.rsplit_once('-').unwrap_or((key, ""));
        (project.to_string(), number.parse::<u64>().unwrap_or(0))
    });
    keys.dedup();
    keys
}

/// Bitbucket `~` 검색은 부분 일치라 `PROJ-12`로 `PROJ-123`도 잡히므로, 키워드 바로 뒤에 숫자가 이어지는 경우는 제외합니다.
fn contains_keyword(name: &str, keyword: &str) -> bool {
    let (name, keyword) = (name.to_lowercase(), keyword.to_lowercase());
    name.match_indices(&keyword)
        .any(|(i, _)| !name[i + keyword.len()..].starts_with(|c: char| c.is_ascii_digit()))
}

// --- App Context ---
struct AppContext {
    client: Client,

    // Bitbucket Config
    bb_workspace: String,
    bb_repo: String,
    bb_token: String,

    // Jira Config
    jira_host: String,
    atlassian_email: String,
    jira_token: String,
}

impl AppContext {
    fn from_env() -> Result<Self> {
        // 우선순위: 셸 환경변수 > 현재 경로(상위 포함)의 .env > ~/.config/simple-pr/.env
        // dotenvy는 이미 설정된 값을 덮어쓰지 않으므로 먼저 읽은 쪽이 우선한다.
        let _ = dotenvy::dotenv();
        let config_dir = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
        if let Some(dir) = config_dir {
            let _ = dotenvy::from_path(dir.join("simple-pr/.env"));
        }

        Ok(Self {
            client: Client::builder()
                .user_agent("pr-tool/1.0")
                .build()?,

            // Bitbucket (Atlassian 계정 이메일 + scoped API token, Basic Auth)
            bb_workspace: env::var("BITBUCKET_WORKSPACE").context("Env BITBUCKET_WORKSPACE missing")?,
            bb_repo:      env::var("BITBUCKET_REPO_SLUG").context("Env BITBUCKET_REPO_SLUG missing")?,
            bb_token:     env::var("BITBUCKET_API_TOKEN").context("Env BITBUCKET_API_TOKEN missing")?,

            // Jira (Basic Auth용)
            jira_host:    env::var("JIRA_HOST").context("Env JIRA_HOST missing")?,
            atlassian_email:   env::var("ATLASSIAN_EMAIL").context("Env ATLASSIAN_EMAIL missing")?,
            jira_token:   env::var("JIRA_API_TOKEN").context("Env JIRA_API_TOKEN missing")?,
        })
    }

    // --- API Helpers ---
    async fn check_status(&self, resp: Response, url: &str, service: &str) -> Result<Response> {
        if resp.status().is_success() {
            Ok(resp)
        } else {
            let status = resp.status();
            let error_text = resp.text().await.unwrap_or_default();
            Err(anyhow::anyhow!(
                "❌ {} API Fail [{}]: {}\n(URL: {})",
                service, status, error_text, url
            ))
        }
    }

    fn bb_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.basic_auth(&self.atlassian_email, Some(&self.bb_token))
    }

    fn jira_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.basic_auth(&self.atlassian_email, Some(&self.jira_token))
    }

    async fn find_branch(&self, keyword: &str) -> Result<String> {
        let url = format!(
            "https://api.bitbucket.org/2.0/repositories/{}/{}/refs/branches",
            self.bb_workspace, self.bb_repo
        );

        let q = format!("name~\"{}\"", keyword);
        let resp = self.bb_auth(self.client.get(&url))
            .query(&[("q", q.as_str()), ("pagelen", "100")])
            .send()
            .await?;

        let resp = self.check_status(resp, &url, "Bitbucket").await?;
        let branches = resp.json::<RepoRefResponse>().await?.values;

        // 1. 정확히 일치하는 브랜치 우선 검색 (dev 등)
        if let Some(exact_match) = branches.iter().find(|b| b.name == keyword) {
            return Ok(exact_match.name.clone());
        }

        // 2. 포함 검색 결과 사용
        branches.into_iter()
            .find(|b| contains_keyword(&b.name, keyword))
            .map(|b| b.name)
            .ok_or_else(|| anyhow::anyhow!("Branch not found for keyword: {}", keyword))
    }

    /// PR 목록에서 source branch 이름으로 직접 검색합니다. (브랜치가 삭제된 병합 PR도 검색 가능)
    async fn search_prs(&self, keyword: &str, filter_to: Option<&str>) -> Result<Vec<RepoPr>> {
        let url = format!(
            "https://api.bitbucket.org/2.0/repositories/{}/{}/pullrequests",
            self.bb_workspace, self.bb_repo
        );

        let mut q = format!("source.branch.name ~ \"{}\"", keyword);
        if let Some(f) = filter_to {
            q.push_str(&format!(" AND destination.branch.name ~ \"{}\"", f));
        }

        let resp = self.bb_auth(self.client.get(&url))
            .query(&[
                ("q", q.as_str()),
                ("state", "ALL"),
                ("sort", "-created_on"),
                ("pagelen", "50")
            ])
            .send()
            .await?;

        let resp = self.check_status(resp, &url, "Bitbucket").await?;
        let resp_json = resp.json::<RepoPrResponse>().await?;
        Ok(resp_json.values.into_iter()
            .filter(|pr| contains_keyword(&pr.source.branch.name, keyword))
            .collect())
    }

    /// PR에 포함된 모든 커밋 메시지에서 Jira 키 후보를 추출합니다. (페이지를 끝까지 따라감)
    async fn pr_commit_keys(&self, pr_id: u64) -> Result<Vec<String>> {
        let mut url = format!(
            "https://api.bitbucket.org/2.0/repositories/{}/{}/pullrequests/{}/commits?pagelen=100",
            self.bb_workspace, self.bb_repo, pr_id
        );

        let mut messages = Vec::new();
        loop {
            let resp = self.bb_auth(self.client.get(&url)).send().await?;
            let resp = self.check_status(resp, &url, "Bitbucket").await?;
            let page = resp.json::<RepoCommitResponse>().await?;
            messages.extend(page.values.into_iter().map(|c| c.message));
            match page.next {
                Some(next) => url = next,
                None => break,
            }
        }
        Ok(jira_keys_in(messages.iter().map(String::as_str)))
    }

    /// Jira 이슈 요약을 조회합니다. 이슈가 없거나 볼 권한이 없으면(404) None.
    async fn get_jira_summary(&self, jira_key: &str) -> Result<Option<String>> {
        let url = format!("{}/rest/api/3/issue/{}", self.jira_host, jira_key);

        // summary만 요청해 응답 크기를 줄인다
        let resp = self.jira_auth(self.client.get(&url))
            .query(&[("fields", "summary")])
            .header("Accept", "application/json")
            .send()
            .await?;

        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let resp = self.check_status(resp, &url, "Jira").await?;
        let issue = resp.json::<JiraIssue>().await?;
        Ok(Some(issue.fields.summary))
    }

    /// 브랜치 이름의 Jira 키로 요약을 조회합니다. 실패하면 경고를 출력하고 None.
    async fn branch_summary(&self, key: &str) -> Option<String> {
        match self.get_jira_summary(key).await {
            Ok(Some(summary)) => Some(summary),
            Ok(None) => {
                eprintln!("⚠️ Jira issue not found: {}", key);
                None
            }
            Err(e) => {
                eprintln!("⚠️ Jira lookup failed for {}: {:#}", key, e);
                None
            }
        }
    }

    /// 브랜치 이름에 Jira 키가 없을 때 사용합니다. PR 커밋 메시지에 언급된 키 중 Jira에 실제로 있는 이슈만 반환합니다.
    /// (`UTF-8`처럼 키 형태지만 이슈가 아닌 문자열은 404로 걸러진다)
    async fn commit_issues(&self, pr_id: u64) -> Vec<LinkedIssue> {
        let keys = match self.pr_commit_keys(pr_id).await {
            Ok(keys) => keys,
            Err(e) => {
                eprintln!("⚠️ Commit lookup failed for PR #{}: {:#}", pr_id, e);
                return Vec::new();
            }
        };

        let summaries = join_all(keys.iter().map(|key| self.get_jira_summary(key))).await;
        keys.into_iter()
            .zip(summaries)
            .filter_map(|(key, result)| match result {
                Ok(summary) => summary.map(|s| LinkedIssue { key, summary: Some(s) }),
                Err(e) => {
                    eprintln!("⚠️ Jira lookup failed for {}: {:#}", key, e);
                    None
                }
            })
            .collect()
    }

    /// PR에 연결할 Jira 이슈: 소스 브랜치 이름의 키, 없으면 PR 커밋 메시지에 언급된 이슈들
    async fn pr_issues(&self, pr: &RepoPr) -> Vec<LinkedIssue> {
        match jira_key(&pr.source.branch.name) {
            Some(key) => vec![LinkedIssue { key: key.to_string(), summary: self.branch_summary(key).await }],
            None => self.commit_issues(pr.id).await,
        }
    }

    async fn create_pr(&self, src_branch: &str, target_branch: &str, title: &str) -> Result<RepoPr> {
        let url = format!(
            "https://api.bitbucket.org/2.0/repositories/{}/{}/pullrequests",
            self.bb_workspace, self.bb_repo
        );

        let payload = CreatePrPayload {
            title,
            source: BranchRef { branch: BranchName { name: src_branch } },
            destination: BranchRef { branch: BranchName { name: target_branch } },
        };

        let resp = self.bb_auth(self.client.post(&url))
            .json(&payload)
            .send()
            .await?;

        let resp = self.check_status(resp, &url, "Bitbucket").await?;
        Ok(resp.json::<RepoPr>().await?)
    }

    /// 소스 브랜치에만 있는 커밋이 하나면 그 제목을 반환합니다. 조회에 실패하면 경고를 출력하고 None.
    async fn branch_commit_subject(&self, src_branch: &str, target_branch: &str) -> Option<String> {
        let url = format!(
            "https://api.bitbucket.org/2.0/repositories/{}/{}/commits",
            self.bb_workspace, self.bb_repo
        );
        let page = async {
            let resp = self.bb_auth(self.client.get(&url))
                .query(&[("include", src_branch), ("exclude", target_branch), ("pagelen", "2")])
                .send()
                .await?;
            let resp = self.check_status(resp, &url, "Bitbucket").await?;
            Ok::<_, anyhow::Error>(resp.json::<RepoCommitResponse>().await?)
        }.await;

        match page {
            Ok(page) => sole_commit_subject(&page).map(str::to_string),
            Err(e) => {
                eprintln!("⚠️ Commit lookup failed for {}: {:#}", src_branch, e);
                None
            }
        }
    }

    /// 키워드로 소스 브랜치를 찾아 제목을 정한 뒤 PR을 생성하고, 출력용으로 연결된 이슈도 함께 반환합니다.
    async fn create_pr_for_key(&self, src_key: &str, target_branch: &str, title: Option<&str>, dry_run: bool) -> Result<KeyOutcome> {
        let src_branch = self.find_branch(src_key).await?;
        let key = jira_key(&src_branch);
        let summary = match key {
            Some(k) => self.branch_summary(k).await,
            None => None,
        };
        let title = match title {
            Some(title) => title.to_string(),
            None => {
                let subject = match key {
                    Some(_) => None,
                    None => self.branch_commit_subject(&src_branch, target_branch).await,
                };
                generated_title(src_key, key, summary.as_deref(), subject.as_deref())
            }
        };
        if dry_run {
            return Ok(KeyOutcome::WouldCreate { src_branch, title });
        }
        let pr = self.create_pr(&src_branch, target_branch, &title).await?;

        // 브랜치 이름에 키가 없으면 생성된 PR의 커밋에서 연결할 이슈를 찾는다
        let issues = match key {
            Some(k) => vec![LinkedIssue { key: k.to_string(), summary }],
            None => self.commit_issues(pr.id).await,
        };
        Ok(KeyOutcome::Created(pr, issues))
    }

    /// 연결된 이슈마다 한 줄씩 출력하고, 연결된 이슈가 없으면 브랜치 이름으로 한 줄 출력합니다.
    fn print_result(&self, pr: &RepoPr, issues: &[LinkedIssue], format: Format) {
        let branch = pr.source.branch.name.as_str();
        let pr_link_str = format!("[PR]({})", pr.links.html.href);
        let icon = match pr.state.as_str() {
            "OPEN" => "🟢",
            "MERGED" => "🟣",
            "DECLINED" => "🔴",
            "SUPERSEDED" => "⚪",
            _ => "❓",
        };
        let state_str = format!("{} {} → {}", icon, pr.state, pr.destination.branch.name);

        match format {
            // Future formats can be added here
            Format::Md => {
                if issues.is_empty() {
                    println!("{} {} {}", branch, pr_link_str, state_str);
                }
                for issue in issues {
                    let jira_link = format!("{}/browse/{}", self.jira_host, issue.key);
                    let sum = issue.summary.as_deref().unwrap_or("(Jira Info Failed)");
                    println!("[{}]({}) {} {} {}", issue.key, jira_link, sum, pr_link_str, state_str);
                }
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // 인자 파싱을 먼저 해서 --help는 환경변수 없이도 동작하게 한다
    let args = Cli::parse();
    if let Commands::Bitbucket(BitbucketArgs { command: Some(BitbucketSubcommands::Create { from, title: Some(_), .. }), .. }) = &args.command
        && from.len() > 1
    {
        Cli::command().error(ErrorKind::ArgumentConflict, "--title allows one --from keyword only").exit();
    }
    let app = AppContext::from_env()?;

    match args.command {
        Commands::Bitbucket(bb_args) => {
            let command = bb_args.command.unwrap_or_else(|| BitbucketSubcommands::Create {
                from: bb_args.from.expect("--from is required for create mode"),
                to: bb_args.to.expect("--to is required for create mode"),
                title: None,
                dry_run: false,
            });

            match command {
                // 1. Find Mode (PR 기반 검색 - 브랜치 삭제 여부와 무관하게 검색 가능)
                BitbucketSubcommands::Find { from, to, format, all } => {
                    let filter = to.as_deref();
                    let mode = if all { "all" } else { "latest 1 per keyword" };
                    println!("🔍 Searching PRs for from-branch '{}' (to-branch filter: {:?}, mode: {})...", from.join(", "), filter, mode);

                    // PR 검색과 Jira 조회를 각각 동시에 수행하고, 출력은 입력 순서를 유지
                    let pr_groups: Vec<Vec<RepoPr>> = try_join_all(from.iter().map(|keyword| app.search_prs(keyword, filter)))
                        .await?
                        .into_iter()
                        // --all이 없으면 키워드당 최신 1개만 출력
                        .map(|mut prs| {
                            if !all {
                                prs.truncate(1);
                            }
                            prs
                        })
                        .collect();
                    let mut issues = join_all(pr_groups.iter().flatten().map(|pr| app.pr_issues(pr)))
                        .await
                        .into_iter();

                    for (keyword, prs) in from.iter().zip(&pr_groups) {
                        if prs.is_empty() {
                            println!("📭 No PRs found for source branch '{}'", keyword);
                            continue;
                        }
                        for pr in prs {
                            app.print_result(pr, &issues.next().unwrap_or_default(), format);
                        }
                    }
                }
                // 2. Create Mode
                BitbucketSubcommands::Create { from, to, title, dry_run } => {
                    println!("🔍 Finding target branch for '{}'...", to);
                    let target_branch = app.find_branch(&to).await?;
                    println!("🎯 Target Branch: {}\n", target_branch);
                    println!("Processing {} ... ", from.join(", "));

                    // 키별 PR 생성은 서로 독립적이므로 동시에 처리하고, 출력은 입력 순서를 유지
                    let results = join_all(from.iter().map(|src_key| app.create_pr_for_key(src_key, &target_branch, title.as_deref(), dry_run))).await;

                    let mut created = Vec::new();
                    let mut failed = 0;
                    for (src_key, result) in from.iter().zip(results) {
                        match result {
                            Ok(KeyOutcome::WouldCreate { src_branch, title }) => {
                                println!("🧪 Would create: [{}] -> [{}] {}", src_branch, target_branch, title);
                            }
                            Ok(KeyOutcome::Created(pr, issues)) => {
                                println!("✅ Created: [{}] -> [{}]", pr.source.branch.name, target_branch);
                                created.push((pr, issues));
                            }
                            Err(e) => {
                                failed += 1;
                                println!("❌ Failed: [{}] {:#}", src_key, e);
                            }
                        }
                    }

                    if !created.is_empty() {
                        println!("\n🚀 PR Summary:");
                        for (pr, issues) in &created {
                            app.print_result(pr, issues, Format::Md);
                        }
                    }

                    // 일부만 실패해도 호출자(스크립트, 에이전트)가 exit code로 알 수 있게 한다
                    if failed > 0 {
                        anyhow::bail!("{} of {} PRs failed", failed, from.len());
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyword_does_not_match_longer_issue_number() {
        assert!(contains_keyword("feature/PROJ-12-login", "PROJ-12"));
        assert!(contains_keyword("feature/proj-12", "PROJ-12"));
        assert!(!contains_keyword("feature/PROJ-123-login", "PROJ-12"));
        assert!(contains_keyword("develop", "dev"));
    }

    #[test]
    fn extracts_first_jira_key() {
        assert_eq!(jira_key("feature/PROJ-123-login"), Some("PROJ-123"));
        assert_eq!(jira_key("hotfix/PROJ2-7"), Some("PROJ2-7"));
        assert_eq!(jira_key("feature/login-fix"), None);
    }

    #[test]
    fn collects_commit_keys_unique_in_numeric_order() {
        let messages = ["PROJ-100 fix", "Merged in feature/PROJ-53-x (pull request #1)", "PROJ-53, PROJ-9 and UTF-8"];
        assert_eq!(jira_keys_in(messages), ["PROJ-9", "PROJ-53", "PROJ-100", "UTF-8"]);
    }

    #[test]
    fn title_prefers_jira_key_then_sole_commit_then_keyword() {
        assert_eq!(generated_title("kw", Some("PROJ-1"), Some("Login"), Some("subject")), "[PROJ-1] Login");
        assert_eq!(generated_title("kw", Some("PROJ-1"), None, Some("subject")), "[PROJ-1] Task PROJ-1");
        assert_eq!(generated_title("kw", None, None, Some("subject")), "subject");
        assert_eq!(generated_title("kw", None, None, None), "[kw] Update from kw");
    }

    #[test]
    fn commit_subject_requires_exactly_one_commit() {
        let page = |messages: &[&str], next: Option<&str>| RepoCommitResponse {
            values: messages.iter().map(|m| RepoCommit { message: m.to_string() }).collect(),
            next: next.map(str::to_string),
        };
        assert_eq!(sole_commit_subject(&page(&["fix: login\n\nbody"], None)), Some("fix: login"));
        assert_eq!(sole_commit_subject(&page(&["a", "b"], None)), None);
        assert_eq!(sole_commit_subject(&page(&["a"], Some("next-url"))), None);
        assert_eq!(sole_commit_subject(&page(&[], None)), None);
        assert_eq!(sole_commit_subject(&page(&["\n"], None)), None);
    }
}
