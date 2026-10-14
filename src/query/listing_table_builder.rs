/*
 * Parseable Server (C) 2022 - 2025 Parseable, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

use std::{ops::Bound, sync::Arc};

use arrow_schema::Schema;
use datafusion::{
    datasource::{
        file_format::parquet::ParquetFormat,
        listing::{ListingOptions, ListingTable, ListingTableConfig, ListingTableUrl},
    },
    error::DataFusionError,
};
use itertools::Itertools;

use crate::{OBJECT_STORE_DATA_GRANULARITY, storage::ObjectStorage, utils::time::TimeRange};

use super::PartialTimeFilter;

// Listing Table Builder for querying old data
#[derive(Debug, Default)]
pub struct ListingTableBuilder {
    stream: String,
    listing: Vec<String>,
}

impl ListingTableBuilder {
    pub fn new(stream: String) -> Self {
        Self {
            stream,
            ..Self::default()
        }
    }

    pub async fn populate_via_listing(
        self,
        storage: Arc<dyn ObjectStorage>,
        time_filters: &[PartialTimeFilter],
    ) -> Result<Self, DataFusionError> {
        self.populate(storage, time_filters, false).await
    }

    /// Native callers supply the complete tenant/dataset prefix. Bound discovery
    /// separately from classic listing without changing classic query behavior.
    pub(crate) async fn populate_native(
        self,
        storage: Arc<dyn ObjectStorage>,
        time_filters: &[PartialTimeFilter],
    ) -> Result<Self, DataFusionError> {
        self.populate(storage, time_filters, true).await
    }

    async fn populate(
        self,
        storage: Arc<dyn ObjectStorage>,
        time_filters: &[PartialTimeFilter],
        native: bool,
    ) -> Result<Self, DataFusionError> {
        // Extract the minimum start time from the time filters.
        let start_time = time_filters
            .iter()
            .filter_map(|filter| match filter {
                PartialTimeFilter::Low(Bound::Excluded(x))
                | PartialTimeFilter::Low(Bound::Included(x)) => Some(x),
                _ => None,
            })
            .min();

        // Extract the maximum end time from the time filters.
        let end_time = time_filters
            .iter()
            .filter_map(|filter| match filter {
                PartialTimeFilter::High(Bound::Excluded(x))
                | PartialTimeFilter::High(Bound::Included(x)) => Some(x),
                _ => None,
            })
            .max();

        let Some((start_time, end_time)) = start_time.zip(end_time) else {
            return Err(DataFusionError::NotImplemented(
                "The time predicate is not supported because of possibly querying older data."
                    .to_string(),
            ));
        };

        if native
            && (*end_time < *start_time || *end_time - *start_time > chrono::TimeDelta::days(366))
        {
            return Err(DataFusionError::ResourcesExhausted(
                "native legacy time discovery budget".into(),
            ));
        }
        // Generate prefixes for the given time range
        let prefixes = TimeRange::new(start_time.and_utc(), end_time.and_utc())
            .generate_prefixes(OBJECT_STORE_DATA_GRANULARITY);

        if native && prefixes.len() > 4096 {
            return Err(DataFusionError::ResourcesExhausted(
                "native legacy prefix budget".into(),
            ));
        }
        // Build all prefixes as relative paths
        let prefixes: Vec<_> = prefixes
            .into_iter()
            .map(|prefix| {
                relative_path::RelativePathBuf::from(format!("{}/{}", self.stream, prefix))
            })
            .collect();

        // Use storage.list_dirs_relative for all prefixes and flatten results
        let mut listing = Vec::new();
        for prefix in prefixes {
            // None because no new data will be created using this method
            match storage.list_dirs_relative(&prefix, &None).await {
                Ok(paths) => {
                    if native
                        && (paths.len() > 4096usize.saturating_sub(listing.len())
                            || paths.iter().any(|path| {
                                path.is_empty()
                                    || path == "."
                                    || path == ".."
                                    || path.contains(['/', '\\'])
                            }))
                    {
                        return Err(DataFusionError::ResourcesExhausted(
                            "native legacy directory budget or invalid path".into(),
                        ));
                    }
                    listing.extend(paths.into_iter().map(|p| prefix.join(p).to_string()));
                }
                Err(e) => {
                    return Err(DataFusionError::External(Box::new(e)));
                }
            }
        }

        let listing = listing.into_iter().sorted().rev().collect_vec();

        Ok(Self {
            stream: self.stream,
            listing,
        })
    }

    pub fn build(
        self,
        schema: Arc<Schema>,
        map: impl Fn(Vec<String>) -> Vec<ListingTableUrl>,
    ) -> Result<Option<Arc<ListingTable>>, DataFusionError> {
        if self.listing.is_empty() {
            return Ok(None);
        }

        let file_format = ParquetFormat::default().with_enable_pruning(true);
        let listing_options =
            ListingOptions::new(Arc::new(file_format)).with_file_extension(".parquet");
        let config = ListingTableConfig::new_with_multi_paths(map(self.listing))
            .with_listing_options(listing_options)
            .with_schema(schema);
        let listing_table = ListingTable::try_new(config)?;

        Ok(Some(Arc::new(listing_table)))
    }
}

#[cfg(test)]
mod native_tests {
    use super::*;
    #[tokio::test]
    async fn native_legacy_window_budget_precedes_io_and_accepts_thirty_days() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Arc::new(crate::storage::LocalFS::new(directory.path().to_owned()));
        let start = chrono::NaiveDate::from_ymd_opt(2000, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let filters = |days| {
            vec![
                PartialTimeFilter::Low(Bound::Included(start)),
                PartialTimeFilter::High(Bound::Excluded(start + chrono::TimeDelta::days(days))),
            ]
        };
        let result = ListingTableBuilder::new("named/logs".into())
            .populate_native(storage.clone(), &filters(367))
            .await;
        assert!(matches!(
            result,
            Err(DataFusionError::ResourcesExhausted(_))
        ));
        let builder = ListingTableBuilder::new("named/logs".into())
            .populate_native(storage, &filters(30))
            .await
            .unwrap();
        assert!(builder.listing.is_empty());
    }
}
