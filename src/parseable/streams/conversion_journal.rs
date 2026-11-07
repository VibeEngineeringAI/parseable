/*
 * Parseable Server (C) 2022 - 2025 Parseable, Inc.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

//! Monotone process-interruption recovery: once a journal exists, its part may
//! only disappear by publication rename. Thus an absent part means published,
//! even when the uploader has already removed the local Parquet. This assumes
//! one Stream/process owns the tree and no delete/recreate with old references.
//! Sync barriers improve durability; this is not a power-loss safety claim.

use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io, path::Component};

const VERSION: u32 = 1;
const MAX_JOURNAL_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    path: PathBuf,
    size: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    stream: String,
    output: String,
    part_size: u64,
    sources: Vec<Source>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ConversionJournal {
    record: Record,
    checksum: String,
}

pub(super) fn journal_path(output: &Path) -> PathBuf {
    let mut path = output.to_path_buf();
    path.add_extension("sources");
    path
}

/// A dangling symlink or an I/O error must also prevent part destruction.
pub(super) fn has_journal(output: &Path) -> bool {
    fs::symlink_metadata(journal_path(output))
        .map_or_else(|e| e.kind() != io::ErrorKind::NotFound, |_| true)
}

pub(super) fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn invalid(path: &Path, reason: impl std::fmt::Display) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("Conversion journal {}: {reason}", path.display()),
    )
}

fn plain_components(path: &Path, count: usize) -> bool {
    // Checking the spelling too rejects paths normalized by Components (./, //).
    let components: Vec<_> = path.components().collect();
    components.len() == count
        && components.iter().all(|c| matches!(c, Component::Normal(_)))
        && components.iter().collect::<PathBuf>() == path
        && path
            .to_str()
            .is_some_and(|s| !s.split('/').any(|c| c.is_empty() || c == "." || c == ".."))
}

fn regular_or_absent(path: &Path, directory: bool) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if (directory && meta.is_dir()) || (!directory && meta.is_file()) => Ok(()),
        Ok(_) => Err(invalid(path, "symlink or unexpected file type")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

impl ConversionJournal {
    #[cfg(test)]
    pub(super) fn resign_for_test(&mut self) {
        self.checksum = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&self.record).unwrap())
        );
    }

    pub(super) fn new(
        stream: &Stream,
        output: &Path,
        sources: &[PathBuf],
    ) -> Result<Self, StagingError> {
        let record = Record {
            version: VERSION,
            stream: stream.stream_name.clone(),
            output: output
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| invalid(output, "invalid output name"))?
                .to_owned(),
            part_size: fs::metadata(parquet_part_path(output))?.len(),
            sources: sources
                .iter()
                .map(|path| {
                    Ok(Source {
                        path: path
                            .strip_prefix(&stream.data_path)
                            .map_err(|e| invalid(path, e))?
                            .to_path_buf(),
                        size: fs::metadata(path)?.len(),
                    })
                })
                .collect::<io::Result<_>>()?,
        };
        let checksum = format!("{:x}", Sha256::digest(serde_json::to_vec(&record)?));
        let journal = Self { record, checksum };
        journal.validate(stream, &journal_path(output))?;
        Ok(journal)
    }

    fn output(&self, stream: &Stream) -> PathBuf {
        stream.data_path.join(&self.record.output)
    }

    fn sources(&self, stream: &Stream) -> Vec<PathBuf> {
        self.record
            .sources
            .iter()
            .map(|s| stream.data_path.join(&s.path))
            .collect()
    }

    fn validate(&self, stream: &Stream, path: &Path) -> Result<(), StagingError> {
        let record = &self.record;
        if record.version != VERSION || record.stream != stream.stream_name {
            return Err(invalid(path, "unsupported version or stream mismatch").into());
        }
        if self.checksum != format!("{:x}", Sha256::digest(serde_json::to_vec(record)?)) {
            return Err(invalid(path, "checksum mismatch").into());
        }
        let output = Path::new(&record.output);
        if !plain_components(output, 1)
            || output.extension().is_none_or(|s| s != "parquet")
            || journal_path(&self.output(stream)) != path
            || record.sources.is_empty()
            || record.part_size == 0
        {
            return Err(invalid(path, "invalid output, size, or empty source list").into());
        }
        regular_or_absent(&parquet_part_path(&self.output(stream)), false)?;
        let mut seen = HashSet::new();
        for source in &record.sources {
            let relative = &source.path;
            if !plain_components(relative, 2)
                || !relative
                    .components()
                    .next()
                    .and_then(|c| c.as_os_str().to_str())
                    .is_some_and(|s| {
                        s.starts_with(INPROCESS_DIR_PREFIX) && s.len() > INPROCESS_DIR_PREFIX.len()
                    })
                || relative
                    .extension()
                    .is_none_or(|s| s != ARROW_FILE_EXTENSION)
                || !seen.insert(relative)
            {
                return Err(invalid(
                    path,
                    format!("invalid or duplicate source {}", relative.display()),
                )
                .into());
            }
            let absolute = stream.data_path.join(relative);
            regular_or_absent(absolute.parent().unwrap(), true)?;
            regular_or_absent(&absolute, false)?;
        }
        Ok(())
    }
}

impl Stream {
    /// Called under the leaf registry lock by every grouping path and journal
    /// install/resolver. Validate the WHOLE inventory before any mutation. A bad
    /// record closes the regroup gate without losing earlier reservations.
    pub(super) fn inventory_conversion_journals(
        &self,
        registry: &mut ConversionClaims,
    ) -> Result<Vec<ConversionJournal>, StagingError> {
        let result = (|| {
            let entries = match fs::read_dir(&self.data_path) {
                Ok(entries) => entries,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(e) => return Err(e.into()),
            };
            let mut paths = Vec::new();
            for entry in entries {
                let path = entry?.path();
                if path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.ends_with(".parquet.sources"))
                {
                    paths.push(path);
                }
            }
            paths.sort();
            let mut journals = Vec::new();
            let mut sources = HashSet::new();
            let mut outputs = HashSet::new();
            for path in paths {
                regular_or_absent(&path, false)?;
                let file = File::open(&path)?;
                if file.metadata()?.len() > MAX_JOURNAL_BYTES {
                    return Err(invalid(&path, "record exceeds size limit").into());
                }
                let mut bytes = Vec::new();
                file.take(MAX_JOURNAL_BYTES + 1).read_to_end(&mut bytes)?;
                if bytes.len() as u64 > MAX_JOURNAL_BYTES {
                    return Err(invalid(&path, "record exceeds size limit").into());
                }
                let journal: ConversionJournal =
                    serde_json::from_slice(&bytes).map_err(|e| invalid(&path, e))?;
                journal.validate(self, &path)?;
                if !outputs.insert(journal.record.output.clone()) {
                    return Err(invalid(&path, "conflicting output ownership").into());
                }
                for source in &journal.record.sources {
                    if !sources.insert(source.path.clone()) {
                        return Err(invalid(
                            &path,
                            format!("conflicting source ownership: {}", source.path.display()),
                        )
                        .into());
                    }
                }
                journals.push(journal);
            }
            Ok(journals)
        })();
        match &result {
            Ok(journals) => {
                registry.journal_dirs = journals
                    .iter()
                    .flat_map(|j: &ConversionJournal| j.sources(self))
                    .filter_map(|s| s.parent().map(Path::to_path_buf))
                    .collect();
            }
            Err(err) => {
                registry.journals_blocked = true;
                error!(
                    "Conversion recovery gate closed for stream {} at {}: {err}",
                    self.stream_name,
                    self.data_path.display()
                );
            }
        }
        result
    }

    /// Freshly created, still claimed directories cannot belong to an older
    /// journal. Every older directory needs a valid inventory, even if it was
    /// successfully claimed before another journal became unreadable.
    pub(super) fn check_conversion_sources(
        &self,
        registry: &mut ConversionClaims,
        output: &Path,
        sources: &[PathBuf],
    ) -> Result<(), StagingError> {
        let owner = registry.outputs.get(&parquet_part_path(output));
        let fresh = owner.is_some()
            && !sources.is_empty()
            && sources.iter().all(|source| {
                source.parent().is_some_and(|dir| {
                    registry.fresh_dirs.contains_key(dir) && registry.dirs.get(dir) == owner
                })
            });
        if !fresh {
            let journals = self.inventory_conversion_journals(registry)?;
            if registry.journals_blocked
                || journals
                    .iter()
                    .any(|journal| journal.sources(self).iter().any(|s| sources.contains(s)))
            {
                return Err(invalid(
                    output,
                    "source ownership is reserved by conversion recovery",
                )
                .into());
            }
        }
        if has_journal(output) {
            return Err(invalid(output, "conflicting conversion ownership").into());
        }
        Ok(())
    }

    pub(super) fn install_conversion_journal(
        &self,
        journal: &ConversionJournal,
    ) -> Result<(), StagingError> {
        let output = journal.output(self);
        let path = journal_path(&output);
        let bytes = serde_json::to_vec(journal)?;
        if bytes.len() as u64 > MAX_JOURNAL_BYTES {
            let reason = format!(
                "record has {} bytes for {} sources, exceeding the {MAX_JOURNAL_BYTES}-byte limit; conversion retains its sources and requires a smaller group",
                bytes.len(),
                journal.record.sources.len()
            );
            error!("Conversion journal {}: {reason}", path.display());
            return Err(invalid(&path, reason).into());
        }
        let tmp = path.with_extension("sources.tmp");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        #[cfg(test)]
        self.conversion_phase(ConversionPhase::JournalTmpSynced);
        // Output claims protect tmp writes/cleanup. Keep only conflict check,
        // install rename and reservations atomic under the registry lock.
        let mut registry = lock_conversion_claims(&self.conversion_claims);
        self.check_conversion_sources(&mut registry, &output, &journal.sources(self))?;
        fs::rename(tmp, path)?;
        // Reserve before a possible sync failure: J is already installed.
        registry.journal_dirs.extend(
            journal
                .sources(self)
                .iter()
                .filter_map(|s| s.parent().map(Path::to_path_buf)),
        );
        for dir in journal
            .sources(self)
            .iter()
            .filter_map(|s| s.parent())
            .collect::<HashSet<_>>()
        {
            if let Some(count) = registry.fresh_dirs.get_mut(dir) {
                *count += 1;
            }
        }
        drop(registry);
        sync_directory(&self.data_path)?;
        Ok(())
    }

    pub(super) fn resolve_conversion_journals(
        &self,
        tenant_id: &Option<String>,
    ) -> Result<(), StagingError> {
        let mut claim = ConversionClaim::new(&self.conversion_claims);
        let journals = {
            let mut registry = lock_conversion_claims(&self.conversion_claims);
            // Tmp files are never ownership records. A live output claim is
            // installed before its tmp is opened, so this check and deletion
            // cannot race that writer. Run even when the inventory is invalid.
            if let Ok(entries) = fs::read_dir(&self.data_path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(output) = path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .and_then(|s| s.strip_suffix(".parquet.sources.tmp"))
                    {
                        let output = self.data_path.join(format!("{output}.parquet"));
                        if !registry.outputs.contains_key(&parquet_part_path(&output))
                            && let Err(err) = remove_file(&path)
                            && err.kind() != io::ErrorKind::NotFound
                        {
                            warn!(
                                "Cannot remove abandoned journal tmp {}: {err}",
                                path.display()
                            );
                        }
                    }
                }
            }
            let journals = self.inventory_conversion_journals(&mut registry)?;
            registry.journals_blocked = false;
            journals
                .into_iter()
                .filter(|journal| {
                    let part = parquet_part_path(&journal.output(self));
                    if registry.outputs.contains_key(&part) {
                        return false;
                    }
                    registry.outputs.insert(part.clone(), claim.id);
                    claim.outputs.push(part);
                    true
                })
                .collect::<Vec<_>>()
        };
        let mut first_error = None;
        for journal in journals {
            let result = (|| {
                let output = journal.output(self);
                let part = parquet_part_path(&output);
                if part.try_exists()? {
                    if fs::metadata(&part)?.len() != journal.record.part_size
                        || !Self::is_valid_parquet_file(&part, &self.stream_name)
                    {
                        return Err(
                            invalid(&journal_path(&output), "part size/footer mismatch").into()
                        );
                    }
                    #[cfg(test)]
                    self.conversion_phase(ConversionPhase::JournalInstalled);
                    self.publish_parquet(&part, &output, &journal.sources(self))?;
                } else {
                    // P may already have been uploaded and removed. Never
                    // recreate it. Reconcile memory under the same query lock.
                    let _publication = self
                        .publication
                        .write()
                        .map_err(|e| StagingError::PoisonError(PoisonError::new(e.to_string())))?;
                    self.release_pending(&journal.sources(self));
                    drop(_publication);
                    sync_directory(&self.data_path)?;
                    #[cfg(test)]
                    self.conversion_phase(ConversionPhase::AfterPublish);
                }
                self.retire_conversion_sources(&journal, tenant_id)
            })();
            if let Err(err) = result {
                error!(
                    "Cannot resolve {} for stream {}: {err}",
                    journal_path(&journal.output(self)).display(),
                    self.stream_name
                );
                if first_error.is_none() {
                    first_error = Some(err);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub(super) fn retire_conversion_sources(
        &self,
        journal: &ConversionJournal,
        tenant_id: &Option<String>,
    ) -> Result<(), StagingError> {
        let output = journal.output(self);
        let mut dirs = HashSet::new();
        for (ordinal, source) in journal.record.sources.iter().enumerate() {
            let path = self.data_path.join(&source.path);
            let parent = path.parent().unwrap();
            dirs.insert(parent.to_path_buf());
            regular_or_absent(parent, true)?;
            regular_or_absent(&path, false)?;
            match fs::metadata(&path) {
                Ok(meta) => {
                    if meta.len() != source.size {
                        return Err(invalid(
                            &journal_path(&output),
                            format!("source size mismatch: {}", path.display()),
                        )
                        .into());
                    }
                    #[cfg(test)]
                    self.fail_journal_io(JournalFault::SourceUnlink)?;
                    remove_file(&path)?;
                    metrics::STORAGE_SIZE
                        .with_label_values(&[
                            "staging",
                            &self.stream_name,
                            ARROW_FILE_EXTENSION,
                            tenant_id.as_deref().unwrap_or(DEFAULT_TENANT),
                        ])
                        .sub(source.size as i64);
                    #[cfg(test)]
                    self.conversion_phase(ConversionPhase::SourceRemoved {
                        source: &path,
                        ordinal,
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            #[cfg(not(test))]
            let _ = ordinal;
        }
        // Sync each distinct parent once, including parents whose sources were
        // already absent. A missing parent necessarily has no remaining source.
        for dir in &dirs {
            match sync_directory(dir) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        #[cfg(test)]
        self.conversion_phase(ConversionPhase::SourcesRetired);
        #[cfg(test)]
        self.fail_journal_io(JournalFault::JournalRemoval)?;
        let mut registry = lock_conversion_claims(&self.conversion_claims);
        remove_file(journal_path(&output))?;
        for dir in &dirs {
            if let Some(count) = registry.fresh_dirs.get_mut(dir) {
                *count -= 1;
                if *count == 0 {
                    registry.journal_dirs.remove(dir);
                }
            }
        }
        sync_directory(&self.data_path)?;
        // Refresh exclusions and do housekeeping under the registry lock so
        // another grouper cannot reuse a name while it is being removed.
        let inventory_valid = self.inventory_conversion_journals(&mut registry).is_ok();
        for dir in dirs {
            if (inventory_valid && !registry.journal_dirs.contains(&dir))
                || registry.fresh_dirs.get(&dir) == Some(&0)
            {
                match fs::remove_dir(&dir) {
                    Ok(()) => {}
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
                        ) => {}
                    Err(e) => warn!(
                        "Cannot remove empty processing directory {}: {e}",
                        dir.display()
                    ),
                }
            }
        }
        sync_directory(&self.data_path)?;
        Ok(())
    }
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum JournalFault {
    Schema,
    SourceUnlink,
    JournalRemoval,
}

#[cfg(test)]
impl Stream {
    pub(super) fn fail_journal_io(&self, fault: JournalFault) -> io::Result<()> {
        let mut armed = self.journal_fault.lock().unwrap();
        if *armed == Some(fault) {
            *armed = None;
            Err(io::Error::other("issue95 injected I/O failure"))
        } else {
            Ok(())
        }
    }
}
