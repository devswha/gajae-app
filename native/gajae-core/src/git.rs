use std::ffi::OsStr;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_DIFF_BYTES: usize = 16 * 1024 * 1024;
const MAX_DIFF_ITEMS: usize = 10_000;
const CHUNK_BYTES: usize = 36 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u8,
    kind: String,
    id: String,
    method: String,
    params: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    protocol_version: u8,
    kind: &'static str,
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Error>,
}

#[derive(Serialize)]
struct Error {
    code: &'static str,
}

#[derive(Clone, Copy)]
enum GitError {
    InvalidRequest,
    InvalidPath,
    NotRepository,
    NotManagedWorktree,
    AlreadyExists,
    BranchConflict,
    DirtyWorktree,
    UnsupportedEncoding,
    OutputTooLarge,
    GitFailed,
}

impl GitError {
    fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::InvalidPath => "invalid_path",
            Self::NotRepository => "not_repository",
            Self::NotManagedWorktree => "not_managed_worktree",
            Self::AlreadyExists => "already_exists",
            Self::BranchConflict => "branch_conflict",
            Self::DirtyWorktree => "dirty_worktree",
            Self::UnsupportedEncoding => "unsupported_encoding",
            Self::OutputTooLarge => "output_too_large",
            Self::GitFailed => "git_failed",
        }
    }
}

#[derive(Clone)]
struct Worktree {
    path: PathBuf,
    head: String,
    branch: Option<String>,
    locked: bool,
    prunable: bool,
}

/// Runs the version 1 git NDJSON protocol. A false result is a process-fatal
/// protocol or startup error; semantic request failures are correlated replies.
pub fn run<R: BufRead, W: Write>(workdir: &Path, mut input: R, mut output: W) -> bool {
    let workdir = match validate_workdir(workdir) {
        Ok(path) => path,
        Err(_) => return false,
    };
    if !write_json(&mut output, &json!({"protocolVersion": 1, "kind": "ready"})) {
        return false;
    }
    let mut frame = Vec::new();
    loop {
        frame.clear();
        let read = match Read::by_ref(&mut input)
            .take(MAX_FRAME_BYTES as u64 + 1)
            .read_until(b'\n', &mut frame)
        {
            Ok(value) => value,
            Err(_) => return false,
        };
        if read == 0 {
            return true;
        }
        if frame.len() > MAX_FRAME_BYTES || !frame.ends_with(b"\n") {
            return false;
        }
        frame.pop();
        let request: Request = match serde_json::from_slice(&frame) {
            Ok(value) => value,
            Err(_) => return false,
        };
        if request.protocol_version != 1 || request.kind != "request" || !valid_id(&request.id) {
            return false;
        }
        let mut stream = Vec::new();
        let response = match dispatch(&workdir, &request, &mut stream) {
            Ok(result) => Response {
                protocol_version: 1,
                kind: "response",
                id: &request.id,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Response {
                protocol_version: 1,
                kind: "response",
                id: &request.id,
                ok: false,
                result: None,
                error: Some(Error { code: error.code() }),
            },
        };
        for value in stream {
            if !write_json(&mut output, &value) {
                return false;
            }
        }
        let encoded = match serde_json::to_vec(&response) {
            Ok(value) if value.len() < MAX_FRAME_BYTES => value,
            _ => return false,
        };
        if output.write_all(&encoded).is_err()
            || output.write_all(b"\n").is_err()
            || output.flush().is_err()
        {
            return false;
        }
    }
}

fn write_json<W: Write>(output: &mut W, value: &Value) -> bool {
    match serde_json::to_vec(value) {
        Ok(bytes) if bytes.len() < MAX_FRAME_BYTES => {
            output.write_all(&bytes).is_ok()
                && output.write_all(b"\n").is_ok()
                && output.flush().is_ok()
        }
        _ => false,
    }
}

fn dispatch(workdir: &Path, request: &Request, stream: &mut Vec<Value>) -> Result<Value, GitError> {
    match request.method.as_str() {
        "worktree.create" => create(workdir, &request.params),
        "worktree.list" => list(workdir, &request.id, &request.params, stream),
        "status" => status(workdir, &request.id, &request.params, stream),
        "diff" => diff(workdir, &request.id, &request.params, stream),
        "worktree.prune" => prune(workdir, &request.params),
        _ => Err(GitError::InvalidRequest),
    }
}

fn fields(params: &Value, confirmed: bool) -> Result<(String, String, PathBuf), GitError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Fields {
        job_id: String,
        branch: String,
        path: PathBuf,
        #[serde(default)]
        confirmed: bool,
    }
    let fields: Fields =
        serde_json::from_value(params.clone()).map_err(|_| GitError::InvalidRequest)?;
    if confirmed && !fields.confirmed {
        return Err(GitError::InvalidRequest);
    }
    if !valid_id(&fields.job_id) || fields.branch != format!("job/{}", fields.job_id) {
        return Err(GitError::InvalidRequest);
    }
    Ok((fields.job_id, fields.branch, fields.path))
}

fn create(workdir: &Path, params: &Value) -> Result<Value, GitError> {
    let (job_id, branch, path) = fields(params, false)?;
    let path = managed_path(workdir, &job_id, &path)?;
    let entries = worktrees(workdir)?;
    if let Some(existing) = entries.iter().find(|item| item.path == path) {
        if existing.branch.as_deref() == Some(&format!("refs/heads/{branch}")) {
            return Ok(worktree_result(false, &job_id, &branch, existing));
        }
        return Err(GitError::BranchConflict);
    }
    if entries
        .iter()
        .any(|item| item.branch.as_deref() == Some(&format!("refs/heads/{branch}")))
    {
        return Err(GitError::BranchConflict);
    }
    if git_status(
        workdir,
        [
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    ) {
        return Err(GitError::BranchConflict);
    }
    if path.exists() {
        return Err(GitError::AlreadyExists);
    }
    let root = managed_root(workdir)?;
    std::fs::create_dir_all(&root).map_err(|_| GitError::InvalidPath)?;
    let base = git_text(workdir, ["rev-parse", "HEAD^{commit}"])?;
    let status = git_status(
        workdir,
        [
            "-c",
            "core.hooksPath=/dev/null",
            "worktree",
            "add",
            "-b",
            &branch,
            "--",
            path.to_str().ok_or(GitError::UnsupportedEncoding)?,
            &base,
        ],
    );
    if !status {
        return Err(GitError::GitFailed);
    }
    let item = worktrees(workdir)?
        .into_iter()
        .find(|item| item.path == path)
        .ok_or(GitError::GitFailed)?;
    Ok(worktree_result(true, &job_id, &branch, &item))
}

fn list(
    workdir: &Path,
    id: &str,
    params: &Value,
    stream: &mut Vec<Value>,
) -> Result<Value, GitError> {
    if params.as_object().is_none_or(|object| !object.is_empty()) {
        return Err(GitError::InvalidRequest);
    }
    let root = managed_root(workdir)?;
    let mut count = 0_u64;
    for item in worktrees(workdir)? {
        if item.path.starts_with(&root) {
            let job_id = item
                .path
                .file_name()
                .and_then(OsStr::to_str)
                .ok_or(GitError::UnsupportedEncoding)?;
            if !valid_id(job_id) {
                continue;
            }
            let Some(branch) = item
                .branch
                .as_deref()
                .and_then(|value| value.strip_prefix("refs/heads/"))
            else {
                continue;
            };
            if branch != format!("job/{job_id}") {
                continue;
            }
            stream.push(json!({"protocolVersion":1,"kind":"item","id":id,"sequence":count,"item":{"worktreeId":item.path,"jobId":job_id,"path":item.path,"branch":branch,"head":item.head,"locked":item.locked,"prunable":item.prunable}}));
            count += 1;
        }
    }
    Ok(json!({"count": count}))
}

fn status(
    workdir: &Path,
    id: &str,
    params: &Value,
    stream: &mut Vec<Value>,
) -> Result<Value, GitError> {
    let (_, _, path) = fields(params, false)?;
    let path = registered(workdir, params, &path)?;
    let bytes = git_bytes(
        &path,
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=no",
        ],
    )?;
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty());
    let mut count = 0_u64;
    while let Some(record) = records.next() {
        if record.len() < 4 || record[2] != b' ' {
            return Err(GitError::GitFailed);
        }
        let index = record[0] as char;
        let worktree = record[1] as char;
        let path_value =
            std::str::from_utf8(&record[3..]).map_err(|_| GitError::UnsupportedEncoding)?;
        let original = if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
            Some(
                std::str::from_utf8(records.next().ok_or(GitError::GitFailed)?)
                    .map_err(|_| GitError::UnsupportedEncoding)?,
            )
        } else {
            None
        };
        let kind = match (index, worktree) {
            ('?', '?') => "untracked",
            ('A', _) | (_, 'A') => "added",
            ('D', _) | (_, 'D') => "deleted",
            ('R', _) | (_, 'R') => "renamed",
            ('C', _) | (_, 'C') => "copied",
            ('U', _) | (_, 'U') => "unmerged",
            _ => "modified",
        };
        stream.push(json!({"protocolVersion":1,"kind":"item","id":id,"sequence":count,"item":{"path":path_value,"kind":kind,"index":index.to_string(),"worktree":worktree.to_string(),"originalPath":original}}));
        count += 1;
    }
    Ok(json!({"clean": count == 0, "count": count}))
}

fn diff(
    workdir: &Path,
    id: &str,
    params: &Value,
    stream: &mut Vec<Value>,
) -> Result<Value, GitError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Diff {
        job_id: String,
        branch: String,
        path: PathBuf,
        mode: String,
        #[serde(default)]
        include_untracked: bool,
    }
    let value: Diff =
        serde_json::from_value(params.clone()).map_err(|_| GitError::InvalidRequest)?;
    let (_, _, requested) = fields(
        &json!({"jobId":value.job_id,"branch":value.branch,"path":value.path}),
        false,
    )?;
    let path = registered(workdir, params, &requested)?;
    let mut args = vec![
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
    ];
    match value.mode.as_str() {
        "head" => args.push("HEAD"),
        "staged" => args.push("--cached"),
        "unstaged" => {}
        _ => return Err(GitError::InvalidRequest),
    }
    args.push("--");
    let mut bytes = git_bytes(&path, args)?;
    if value.include_untracked {
        let untracked = git_bytes(&path, ["ls-files", "--others", "--exclude-standard", "-z"])?;
        let paths: Vec<&str> = untracked
            .split(|b| *b == 0)
            .filter(|v| !v.is_empty())
            .map(|v| std::str::from_utf8(v).map_err(|_| GitError::UnsupportedEncoding))
            .collect::<Result<_, _>>()?;
        if paths.len() > MAX_DIFF_ITEMS {
            return Err(GitError::OutputTooLarge);
        }
        for name in paths {
            let output = git_output(
                &path,
                [
                    "diff",
                    "--binary",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--no-index",
                    "--",
                    "/dev/null",
                    name,
                ],
            )?;
            if !output.status.success() && output.status.code() != Some(1) {
                return Err(GitError::GitFailed);
            }
            bytes.extend_from_slice(&output.stdout);
            if bytes.len() > MAX_DIFF_BYTES {
                return Err(GitError::OutputTooLarge);
            }
        }
    }
    if bytes.len() > MAX_DIFF_BYTES {
        return Err(GitError::OutputTooLarge);
    }
    let chunks = bytes.chunks(CHUNK_BYTES).enumerate().map(|(sequence, chunk)| { stream.push(json!({"protocolVersion":1,"kind":"chunk","id":id,"sequence":sequence,"encoding":"base64","data":STANDARD.encode(chunk)})); 1_u64 }).sum::<u64>();
    Ok(json!({"bytes":bytes.len(),"chunks":chunks,"truncated":false}))
}

fn prune(workdir: &Path, params: &Value) -> Result<Value, GitError> {
    let (_, _, path) = fields(params, true)?;
    let path = registered(workdir, params, &path)?;
    if !git_bytes(
        &path,
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=no",
        ],
    )?
    .is_empty()
    {
        return Err(GitError::DirtyWorktree);
    }
    if !git_status(
        workdir,
        [
            "worktree",
            "remove",
            "--",
            path.to_str().ok_or(GitError::UnsupportedEncoding)?,
        ],
    ) {
        return Err(GitError::GitFailed);
    }
    Ok(json!({"pruned":true,"branchRetained":true}))
}

fn registered(workdir: &Path, params: &Value, requested: &Path) -> Result<PathBuf, GitError> {
    let (job_id, branch, path) = fields(params, false)?;
    let path = managed_path(workdir, &job_id, &path)?;
    if path != requested {
        return Err(GitError::InvalidPath);
    }
    let item = worktrees(workdir)?
        .into_iter()
        .find(|item| item.path == path)
        .ok_or(GitError::NotManagedWorktree)?;
    if item.branch.as_deref() != Some(&format!("refs/heads/{branch}")) {
        return Err(GitError::NotManagedWorktree);
    }
    Ok(path)
}

fn worktree_result(created: bool, job_id: &str, branch: &str, item: &Worktree) -> Value {
    json!({"created":created,"worktree":{"worktreeId":item.path,"jobId":job_id,"path":item.path,"branch":branch,"head":item.head}})
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

fn validate_workdir(workdir: &Path) -> Result<PathBuf, GitError> {
    if !workdir.is_absolute()
        || std::fs::symlink_metadata(workdir)
            .map_err(|_| GitError::InvalidPath)?
            .file_type()
            .is_symlink()
    {
        return Err(GitError::InvalidPath);
    }
    let canonical = std::fs::canonicalize(workdir).map_err(|_| GitError::InvalidPath)?;
    let top = git_text(&canonical, ["rev-parse", "--show-toplevel"])
        .map_err(|_| GitError::NotRepository)?;
    let top = PathBuf::from(top);
    if canonical != top {
        return Err(GitError::InvalidPath);
    }
    Ok(canonical)
}

fn managed_root(workdir: &Path) -> Result<PathBuf, GitError> {
    let root = workdir.join(".gjc-worktrees");
    if std::fs::symlink_metadata(&root).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(GitError::InvalidPath);
    }
    Ok(root)
}

fn managed_path(workdir: &Path, job_id: &str, requested: &Path) -> Result<PathBuf, GitError> {
    if !requested.is_absolute() {
        return Err(GitError::InvalidPath);
    }
    let root = managed_root(workdir)?;
    let expected = root.join(job_id);
    if requested != expected {
        return Err(GitError::InvalidPath);
    }
    let ancestor = nearest_existing(&expected)?;
    let canonical_ancestor = std::fs::canonicalize(&ancestor).map_err(|_| GitError::InvalidPath)?;
    let canonical_workdir = std::fs::canonicalize(workdir).map_err(|_| GitError::InvalidPath)?;
    if canonical_ancestor == canonical_workdir {
        return Ok(expected);
    }
    let canonical_root = std::fs::canonicalize(&root).map_err(|_| GitError::InvalidPath)?;
    if !canonical_ancestor.starts_with(&canonical_root) {
        return Err(GitError::InvalidPath);
    }
    Ok(expected)
}

fn nearest_existing(path: &Path) -> Result<PathBuf, GitError> {
    let mut current = path;
    while !current.exists() {
        current = current.parent().ok_or(GitError::InvalidPath)?;
    }
    Ok(current.to_path_buf())
}

fn worktrees(workdir: &Path) -> Result<Vec<Worktree>, GitError> {
    let bytes = git_bytes(workdir, ["worktree", "list", "--porcelain"])?;
    let mut entries = Vec::new();
    let mut current: Option<Worktree> = None;
    for field in bytes.split(|byte| *byte == b'\n') {
        if field.is_empty() {
            if let Some(item) = current.take() {
                entries.push(item);
            }
            continue;
        }
        let text = std::str::from_utf8(field).map_err(|_| GitError::UnsupportedEncoding)?;
        if let Some(path) = text.strip_prefix("worktree ") {
            if let Some(item) = current.take() {
                entries.push(item);
            }
            current = Some(Worktree {
                path: PathBuf::from(path),
                head: String::new(),
                branch: None,
                locked: false,
                prunable: false,
            });
        } else if let Some(item) = current.as_mut() {
            if let Some(head) = text.strip_prefix("HEAD ") {
                item.head = head.to_owned();
            } else if let Some(branch) = text.strip_prefix("branch ") {
                item.branch = Some(branch.to_owned());
            } else if text.starts_with("locked") {
                item.locked = true;
            } else if text.starts_with("prunable") {
                item.prunable = true;
            }
        }
    }
    if let Some(item) = current {
        entries.push(item);
    }
    Ok(entries)
}

fn git_output<I, S>(dir: &Path, args: I) -> Result<std::process::Output, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git")
        .current_dir(dir)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .env("GIT_EXTERNAL_DIFF", "")
        .args(args)
        .output()
        .map_err(|_| GitError::GitFailed)?;
    Ok(output)
}
fn git_bytes<I, S>(dir: &Path, args: I) -> Result<Vec<u8>, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = git_output(dir, args)?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(GitError::GitFailed)
    }
}
fn git_text<I, S>(dir: &Path, args: I) -> Result<String, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let value = git_bytes(dir, args)?;
    let text = std::str::from_utf8(&value).map_err(|_| GitError::GitFailed)?;
    Ok(text.trim_end_matches(['\r', '\n']).to_owned())
}
fn git_status<I, S>(dir: &Path, args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    git_output(dir, args).is_ok_and(|output| output.status.success())
}
