//! Stable-identity table storage (`SPECIFICATION.html` §5.2–§5.3).
//!
//! A cell's A1 address is a presentation surface over a stable [`CellId`].
//! Formula parsing can therefore resolve a spelling once to [`BoundCellRef`]
//! and keep that identity across table growth and renames. The evaluator and
//! recalculation graph can build on this module without ever treating a grid
//! coordinate as identity.

use super::cell_value::CellValue;
use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

/// Stable identity of a table within one document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TableId(u64);

impl TableId {
    /// Numeric identity for serialization and diagnostics.
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Stable identity of a cell within one document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CellId(u64);

impl CellId {
    /// Numeric identity for serialization and diagnostics.
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Zero-based grid coordinate. Its display and parse form is conventional A1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CellAddress {
    row: usize,
    column: usize,
}

impl CellAddress {
    pub const fn new(row: usize, column: usize) -> Self {
        Self { row, column }
    }

    pub const fn row(self) -> usize {
        self.row
    }

    pub const fn column(self) -> usize {
        self.column
    }
}

impl fmt::Display for CellAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut n = self.column.checked_add(1).ok_or(fmt::Error)?;
        let mut letters = Vec::new();
        while n > 0 {
            let rem = (n - 1) % 26;
            letters.push((b'A' + rem as u8) as char);
            n = (n - 1) / 26;
        }
        for ch in letters.iter().rev() {
            write!(f, "{ch}")?;
        }
        write!(f, "{}", self.row.checked_add(1).ok_or(fmt::Error)?)
    }
}

impl FromStr for CellAddress {
    type Err = StoreError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        let raw = raw.trim();
        let letter_count = raw
            .bytes()
            .take_while(|b| b.is_ascii_alphabetic())
            .count();
        if letter_count == 0 || letter_count == raw.len() {
            return Err(StoreError::InvalidAddress(raw.to_owned()));
        }
        let (letters, digits) = raw.split_at(letter_count);
        if !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(StoreError::InvalidAddress(raw.to_owned()));
        }

        let mut column_one_based = 0usize;
        for byte in letters.bytes() {
            let digit = usize::from(byte.to_ascii_uppercase() - b'A' + 1);
            column_one_based = column_one_based
                .checked_mul(26)
                .and_then(|n| n.checked_add(digit))
                .ok_or_else(|| StoreError::InvalidAddress(raw.to_owned()))?;
        }
        let row_one_based = digits
            .parse::<usize>()
            .map_err(|_| StoreError::InvalidAddress(raw.to_owned()))?;
        if row_one_based == 0 {
            return Err(StoreError::InvalidAddress(raw.to_owned()));
        }

        Ok(Self::new(row_one_based - 1, column_one_based - 1))
    }
}

/// A reference after name/address resolution. It binds to identities, not text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BoundCellRef {
    table_id: TableId,
    cell_id: CellId,
}

impl BoundCellRef {
    pub const fn table_id(self) -> TableId {
        self.table_id
    }

    pub const fn cell_id(self) -> CellId {
        self.cell_id
    }
}

/// One atomic cell in a table.
#[derive(Debug, Clone)]
pub struct Cell {
    id: CellId,
    explicit_name: Option<Arc<str>>,
    value: CellValue,
}

impl Cell {
    fn empty(id: CellId) -> Self {
        Self {
            id,
            explicit_name: None,
            value: CellValue::empty(),
        }
    }

    pub const fn id(&self) -> CellId {
        self.id
    }

    pub fn explicit_name(&self) -> Option<&str> {
        self.explicit_name.as_deref()
    }

    pub fn value(&self) -> &CellValue {
        &self.value
    }
}

/// A finite rectangular table. Coordinates may change; cell identities do not.
#[derive(Debug, Clone)]
pub struct Table {
    id: TableId,
    name: Arc<str>,
    rows: usize,
    columns: usize,
    cells: Vec<Cell>,
    cell_positions: HashMap<CellId, usize>,
    landmarks: HashMap<String, CellId>,
}

impl Table {
    pub const fn id(&self) -> TableId {
        self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn rows(&self) -> usize {
        self.rows
    }

    pub const fn columns(&self) -> usize {
        self.columns
    }

    pub fn cell(&self, address: CellAddress) -> Option<&Cell> {
        self.index_of(address).and_then(|index| self.cells.get(index))
    }

    pub fn cell_by_id(&self, id: CellId) -> Option<&Cell> {
        self.cell_positions.get(&id).and_then(|index| self.cells.get(*index))
    }

    pub fn address_of(&self, id: CellId) -> Option<CellAddress> {
        let index = *self.cell_positions.get(&id)?;
        Some(CellAddress::new(index / self.columns, index % self.columns))
    }

    fn index_of(&self, address: CellAddress) -> Option<usize> {
        if address.row >= self.rows || address.column >= self.columns {
            return None;
        }
        address
            .row
            .checked_mul(self.columns)
            .and_then(|base| base.checked_add(address.column))
    }

    fn preferred_name(&self, id: CellId) -> Option<String> {
        let cell = self.cell_by_id(id)?;
        match cell.explicit_name() {
            Some(name) => Some(name.to_owned()),
            None => self.address_of(id).map(|address| address.to_string()),
        }
    }

    fn rebuild_positions(&mut self) {
        self.cell_positions.clear();
        self.cell_positions.reserve(self.cells.len());
        for (index, cell) in self.cells.iter().enumerate() {
            self.cell_positions.insert(cell.id, index);
        }
    }
}

/// Errors are explicit because silent reference drift is forbidden.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    InvalidDimensions { rows: usize, columns: usize },
    InvalidName(String),
    InvalidAddress(String),
    DuplicateTableName(String),
    DuplicateCellName(String),
    TableNotFound(TableId),
    CellNotFound(CellId),
    CellOutOfBounds { table: TableId, address: CellAddress },
    UnknownTableReference(String),
    UnknownCellReference(String),
    CannotShrink {
        table: TableId,
        current_rows: usize,
        current_columns: usize,
        requested_rows: usize,
        requested_columns: usize,
    },
    SizeOverflow,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::InvalidDimensions { rows, columns } => {
                write!(f, "table dimensions must be non-zero, got {rows}x{columns}")
            }
            StoreError::InvalidName(name) => write!(f, "invalid name: {name:?}"),
            StoreError::InvalidAddress(address) => write!(f, "invalid A1 address: {address:?}"),
            StoreError::DuplicateTableName(name) => write!(f, "duplicate table name: {name}"),
            StoreError::DuplicateCellName(name) => write!(f, "duplicate cell name: {name}"),
            StoreError::TableNotFound(id) => write!(f, "table {} was not found", id.get()),
            StoreError::CellNotFound(id) => write!(f, "cell {} was not found", id.get()),
            StoreError::CellOutOfBounds { table, address } => {
                write!(f, "cell {address} is outside table {}", table.get())
            }
            StoreError::UnknownTableReference(name) => {
                write!(f, "unknown table reference: {name}")
            }
            StoreError::UnknownCellReference(name) => {
                write!(f, "unknown cell reference: {name}")
            }
            StoreError::CannotShrink {
                table,
                current_rows,
                current_columns,
                requested_rows,
                requested_columns,
            } => write!(
                f,
                "table {} cannot shrink from {}x{} to {}x{}",
                table.get(),
                current_rows,
                current_columns,
                requested_rows,
                requested_columns
            ),
            StoreError::SizeOverflow => write!(f, "table size overflow"),
        }
    }
}

impl std::error::Error for StoreError {}

/// Document-owned table store and identity allocator.
#[derive(Debug, Default)]
pub struct DocumentStore {
    next_table_id: u64,
    next_cell_id: u64,
    tables: Vec<Table>,
    table_positions: HashMap<TableId, usize>,
    table_names: HashMap<String, TableId>,
}

impl DocumentStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a non-empty table. `None` chooses the lowest free `TABLEn` name.
    pub fn create_table(
        &mut self,
        name: Option<&str>,
        rows: usize,
        columns: usize,
    ) -> Result<TableId, StoreError> {
        let cell_count = checked_cell_count(rows, columns)?;
        let canonical_name = match name {
            Some(name) => validate_table_name(name)?,
            None => self.next_auto_table_name(),
        };
        if self.table_names.contains_key(&canonical_name) {
            return Err(StoreError::DuplicateTableName(canonical_name));
        }

        let id = self.allocate_table_id();
        let mut cells = Vec::with_capacity(cell_count);
        for _ in 0..cell_count {
            cells.push(Cell::empty(self.allocate_cell_id()));
        }
        let mut table = Table {
            id,
            name: Arc::from(canonical_name.as_str()),
            rows,
            columns,
            cells,
            cell_positions: HashMap::new(),
            landmarks: HashMap::new(),
        };
        table.rebuild_positions();

        self.table_positions.insert(id, self.tables.len());
        self.table_names.insert(canonical_name, id);
        self.tables.push(table);
        Ok(id)
    }

    pub fn table(&self, id: TableId) -> Result<&Table, StoreError> {
        let index = self
            .table_positions
            .get(&id)
            .copied()
            .ok_or(StoreError::TableNotFound(id))?;
        Ok(&self.tables[index])
    }

    pub fn table_by_name(&self, name: &str) -> Result<&Table, StoreError> {
        let canonical = normalize_name(name).ok_or_else(|| StoreError::InvalidName(name.to_owned()))?;
        let id = self
            .table_names
            .get(&canonical)
            .copied()
            .ok_or_else(|| StoreError::UnknownTableReference(name.trim().to_owned()))?;
        self.table(id)
    }

    pub fn rename_table(&mut self, id: TableId, name: &str) -> Result<(), StoreError> {
        let canonical = validate_table_name(name)?;
        if let Some(existing) = self.table_names.get(&canonical) {
            if *existing != id {
                return Err(StoreError::DuplicateTableName(canonical));
            }
        }
        let index = self.table_index(id)?;
        let old_name = self.tables[index].name.to_string();
        self.tables[index].name = Arc::from(canonical.as_str());
        self.table_names.remove(&old_name);
        self.table_names.insert(canonical, id);
        Ok(())
    }

    /// Grow a table while preserving every existing cell identity and address.
    pub fn grow_table(
        &mut self,
        id: TableId,
        rows: usize,
        columns: usize,
    ) -> Result<(), StoreError> {
        let index = self.table_index(id)?;
        let (old_rows, old_columns) = {
            let table = &self.tables[index];
            (table.rows, table.columns)
        };
        checked_cell_count(rows, columns)?;
        if rows < old_rows || columns < old_columns {
            return Err(StoreError::CannotShrink {
                table: id,
                current_rows: old_rows,
                current_columns: old_columns,
                requested_rows: rows,
                requested_columns: columns,
            });
        }
        if rows == old_rows && columns == old_columns {
            return Ok(());
        }

        let added = rows
            .checked_mul(columns)
            .and_then(|new_count| new_count.checked_sub(old_rows * old_columns))
            .ok_or(StoreError::SizeOverflow)?;
        let mut fresh_ids = Vec::with_capacity(added);
        for _ in 0..added {
            fresh_ids.push(self.allocate_cell_id());
        }
        let mut fresh_ids = fresh_ids.into_iter();

        let table = &mut self.tables[index];
        let mut old_cells: Vec<Option<Cell>> = std::mem::take(&mut table.cells)
            .into_iter()
            .map(Some)
            .collect();
        let mut cells = Vec::with_capacity(rows * columns);
        for row in 0..rows {
            for column in 0..columns {
                if row < old_rows && column < old_columns {
                    let old_index = row * old_columns + column;
                    cells.push(old_cells[old_index].take().expect("old cell used once"));
                } else {
                    cells.push(Cell::empty(
                        fresh_ids.next().expect("allocated one id per new cell"),
                    ));
                }
            }
        }
        table.rows = rows;
        table.columns = columns;
        table.cells = cells;
        table.rebuild_positions();
        Ok(())
    }

    pub fn cell(&self, reference: BoundCellRef) -> Result<&Cell, StoreError> {
        self.table(reference.table_id)?
            .cell_by_id(reference.cell_id)
            .ok_or(StoreError::CellNotFound(reference.cell_id))
    }

    pub fn set_cell_value(
        &mut self,
        table_id: TableId,
        address: CellAddress,
        value: CellValue,
    ) -> Result<(), StoreError> {
        let cell = self.cell_mut_at(table_id, address)?;
        cell.value = value;
        Ok(())
    }

    pub fn clear_cell(
        &mut self,
        table_id: TableId,
        address: CellAddress,
    ) -> Result<(), StoreError> {
        self.set_cell_value(table_id, address, CellValue::empty())
    }

    /// Give a cell a document-readable landmark name, or clear it with `None`.
    pub fn set_cell_name(
        &mut self,
        table_id: TableId,
        address: CellAddress,
        name: Option<&str>,
    ) -> Result<(), StoreError> {
        let new_name = name.map(validate_cell_name).transpose()?;
        let new_key = new_name.as_deref().and_then(normalize_name);
        let table_index = self.table_index(table_id)?;
        let cell_index = self.tables[table_index]
            .index_of(address)
            .ok_or(StoreError::CellOutOfBounds {
                table: table_id,
                address,
            })?;
        let cell_id = self.tables[table_index].cells[cell_index].id;

        if let Some(key) = &new_key {
            if let Some(existing) = self.tables[table_index].landmarks.get(key) {
                if *existing != cell_id {
                    return Err(StoreError::DuplicateCellName(
                        new_name.clone().expect("key implies a name"),
                    ));
                }
            }
        }

        let table = &mut self.tables[table_index];
        if let Some(old_name) = table.cells[cell_index].explicit_name.take() {
            if let Some(old_key) = normalize_name(&old_name) {
                table.landmarks.remove(&old_key);
            }
        }
        if let Some(name) = new_name {
            table.cells[cell_index].explicit_name = Some(Arc::from(name.as_str()));
            table
                .landmarks
                .insert(new_key.expect("validated name has a key"), cell_id);
        }
        Ok(())
    }

    /// Resolve `A1`, `Total`, `TABLE2.A1`, or `TABLE2.Total` to stable IDs.
    pub fn resolve_cell_reference(
        &self,
        current_table: TableId,
        spelling: &str,
    ) -> Result<BoundCellRef, StoreError> {
        let spelling = spelling.trim();
        if spelling.is_empty() {
            return Err(StoreError::UnknownCellReference(String::new()));
        }
        let (table_id, member) = match spelling.split_once('.') {
            Some((table_name, member)) if !table_name.is_empty() && !member.is_empty() => {
                (self.table_by_name(table_name)?.id, member)
            }
            Some(_) => return Err(StoreError::UnknownCellReference(spelling.to_owned())),
            None => (current_table, spelling),
        };
        let table = self.table(table_id)?;
        let cell_id = match member.parse::<CellAddress>() {
            Ok(address) => table
                .cell(address)
                .map(Cell::id)
                .ok_or_else(|| StoreError::UnknownCellReference(spelling.to_owned()))?,
            Err(_) => {
                let key = normalize_name(member)
                    .ok_or_else(|| StoreError::UnknownCellReference(spelling.to_owned()))?;
                table
                    .landmarks
                    .get(&key)
                    .copied()
                    .ok_or_else(|| StoreError::UnknownCellReference(spelling.to_owned()))?
            }
        };
        Ok(BoundCellRef { table_id, cell_id })
    }

    /// Render a bound reference using current preferred names and coordinates.
    pub fn render_reference(
        &self,
        current_table: TableId,
        reference: BoundCellRef,
    ) -> Result<String, StoreError> {
        let table = self.table(reference.table_id)?;
        let member = table
            .preferred_name(reference.cell_id)
            .ok_or(StoreError::CellNotFound(reference.cell_id))?;
        if current_table == reference.table_id {
            Ok(member)
        } else {
            Ok(format!("{}.{}", table.name, member))
        }
    }

    fn table_index(&self, id: TableId) -> Result<usize, StoreError> {
        self.table_positions
            .get(&id)
            .copied()
            .ok_or(StoreError::TableNotFound(id))
    }

    fn cell_mut_at(
        &mut self,
        table_id: TableId,
        address: CellAddress,
    ) -> Result<&mut Cell, StoreError> {
        let table_index = self.table_index(table_id)?;
        let cell_index = self.tables[table_index]
            .index_of(address)
            .ok_or(StoreError::CellOutOfBounds {
                table: table_id,
                address,
            })?;
        Ok(&mut self.tables[table_index].cells[cell_index])
    }

    fn allocate_table_id(&mut self) -> TableId {
        self.next_table_id += 1;
        TableId(self.next_table_id)
    }

    fn allocate_cell_id(&mut self) -> CellId {
        self.next_cell_id += 1;
        CellId(self.next_cell_id)
    }

    fn next_auto_table_name(&self) -> String {
        let mut n = 1usize;
        loop {
            let candidate = format!("TABLE{n}");
            if !self.table_names.contains_key(&candidate) {
                return candidate;
            }
            n += 1;
        }
    }
}

fn checked_cell_count(rows: usize, columns: usize) -> Result<usize, StoreError> {
    if rows == 0 || columns == 0 {
        return Err(StoreError::InvalidDimensions { rows, columns });
    }
    rows.checked_mul(columns).ok_or(StoreError::SizeOverflow)
}

fn normalize_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_uppercase())
}

fn validate_table_name(raw: &str) -> Result<String, StoreError> {
    let canonical = normalize_name(raw).ok_or_else(|| StoreError::InvalidName(raw.to_owned()))?;
    if canonical.contains('.')
        || canonical.chars().any(char::is_whitespace)
        || canonical.parse::<CellAddress>().is_ok()
    {
        return Err(StoreError::InvalidName(raw.to_owned()));
    }
    Ok(canonical)
}

fn validate_cell_name(raw: &str) -> Result<String, StoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.contains('.')
        || trimmed.chars().any(char::is_whitespace)
        || trimmed.parse::<CellAddress>().is_ok()
    {
        return Err(StoreError::InvalidName(raw.to_owned()));
    }
    Ok(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a1_addresses_round_trip() {
        for (text, row, column) in [
            ("A1", 0, 0),
            ("Z9", 8, 25),
            ("AA10", 9, 26),
            ("XFD1048576", 1_048_575, 16_383),
        ] {
            let address: CellAddress = text.parse().unwrap();
            assert_eq!(address, CellAddress::new(row, column));
            assert_eq!(address.to_string(), text);
        }
        assert!("A0".parse::<CellAddress>().is_err());
        assert!("1A".parse::<CellAddress>().is_err());
        assert!("A-1".parse::<CellAddress>().is_err());
    }

    #[test]
    fn table_creation_allocates_empty_cells_with_stable_ids() {
        let mut store = DocumentStore::new();
        let table_id = store.create_table(None, 2, 2).unwrap();
        let table = store.table(table_id).unwrap();
        assert_eq!(table.name(), "TABLE1");
        assert_eq!((table.rows(), table.columns()), (2, 2));
        let a1 = table.cell("A1".parse().unwrap()).unwrap();
        let b2 = table.cell("B2".parse().unwrap()).unwrap();
        assert_ne!(a1.id(), b2.id());
        assert!(a1.value().is_empty());
        assert!(b2.value().is_empty());
    }

    #[test]
    fn growth_preserves_existing_cell_identity() {
        let mut store = DocumentStore::new();
        let table_id = store.create_table(Some("Input"), 2, 2).unwrap();
        let before = store
            .table(table_id)
            .unwrap()
            .cell("B2".parse().unwrap())
            .unwrap()
            .id();

        store.grow_table(table_id, 4, 3).unwrap();

        let table = store.table(table_id).unwrap();
        assert_eq!(table.cell("B2".parse().unwrap()).unwrap().id(), before);
        assert_eq!(table.address_of(before).unwrap().to_string(), "B2");
        assert!(table.cell("C4".parse().unwrap()).unwrap().value().is_empty());
    }

    #[test]
    fn references_bind_to_identity_and_rerender_after_renames() {
        let mut store = DocumentStore::new();
        let input = store.create_table(Some("Input"), 1, 2).unwrap();
        let report = store.create_table(Some("Report"), 1, 1).unwrap();
        store
            .set_cell_name(input, "B1".parse().unwrap(), Some("Total"))
            .unwrap();

        let bound = store
            .resolve_cell_reference(report, "input.total")
            .unwrap();
        assert_eq!(store.render_reference(report, bound).unwrap(), "INPUT.Total");

        store.rename_table(input, "Source").unwrap();
        store
            .set_cell_name(input, "B1".parse().unwrap(), Some("GrandTotal"))
            .unwrap();
        assert_eq!(store.render_reference(report, bound).unwrap(), "SOURCE.GrandTotal");
        assert_eq!(store.cell(bound).unwrap().id(), bound.cell_id());
    }

    #[test]
    fn landmark_names_are_unique_case_insensitively() {
        let mut store = DocumentStore::new();
        let table = store.create_table(None, 1, 2).unwrap();
        store
            .set_cell_name(table, "A1".parse().unwrap(), Some("Total"))
            .unwrap();
        let error = store
            .set_cell_name(table, "B1".parse().unwrap(), Some("TOTAL"))
            .unwrap_err();
        assert_eq!(error, StoreError::DuplicateCellName("TOTAL".to_owned()));
    }

    #[test]
    fn local_and_qualified_a1_references_resolve() {
        let mut store = DocumentStore::new();
        let first = store.create_table(Some("First"), 2, 2).unwrap();
        let second = store.create_table(Some("Second"), 1, 1).unwrap();
        let local = store.resolve_cell_reference(first, "b2").unwrap();
        let qualified = store.resolve_cell_reference(second, "FIRST.B2").unwrap();
        assert_eq!(local, qualified);
        assert_eq!(store.render_reference(first, local).unwrap(), "B2");
        assert_eq!(store.render_reference(second, local).unwrap(), "FIRST.B2");
    }
}
