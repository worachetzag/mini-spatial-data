import React, { useEffect, useMemo, useState } from "react";
import maplibregl from "maplibre-gl";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const DEFAULT_MAP_STYLE =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const PAGE_SIZE = 10;

function extractPointCoordinates(list) {
  return list
    .map((place) => place?.geometry?.coordinates)
    .filter(
      (coords) =>
        Array.isArray(coords) &&
        coords.length >= 2 &&
        !Number.isNaN(Number(coords[0])) &&
        !Number.isNaN(Number(coords[1]))
    )
    .map((coords) => [Number(coords[0]), Number(coords[1])]);
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function toastId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function App() {
  const [places, setPlaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [viewMode, setViewMode] = useState("table");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalRecords, setTotalRecords] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [selectedPlaceId, setSelectedPlaceId] = useState("");
  const [form, setForm] = useState({
    name: "",
    lng: "",
    lat: ""
  });
  const [editingId, setEditingId] = useState("");
  const [toasts, setToasts] = useState([]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [filterInput, setFilterInput] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const mapContainerRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const markersRef = React.useRef([]);
  const markerByIdRef = React.useRef({});
  const draftMarkerRef = React.useRef(null);
  const clickPopupRef = React.useRef(null);
  const placesRef = React.useRef(places);
  const createPlaceFromMapRef = React.useRef(async () => {});

  placesRef.current = places;

  const apiUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/places` : ""),
    []
  );
  const exportUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/places/export` : ""),
    []
  );
  const importUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/places/import` : ""),
    []
  );
  const bulkDeleteUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/places/bulk-delete` : ""),
    []
  );

  function showToast(message, kind = "info") {
    const id = toastId();
    setToasts((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 2500);
  }

  async function loadPlaces(targetPage = currentPage, filterOverride) {
    const q = filterOverride !== undefined ? filterOverride : appliedFilter;
    setLoading(true);
    setError("");
    if (!apiUrl) {
      setLoading(false);
      setError("Missing VITE_API_BASE_URL");
      return;
    }
    try {
      const params = new URLSearchParams({
        page: String(targetPage),
        limit: String(PAGE_SIZE)
      });
      if (q.trim()) {
        params.set("q", q.trim());
      }
      const response = await fetch(`${apiUrl}?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const json = await response.json();
      const nextPlaces = Array.isArray(json.data) ? json.data : [];
      const nextTotal = Number(json.total ?? nextPlaces.length ?? 0);
      const nextLimit = Number(json.limit ?? PAGE_SIZE);
      const computedTotalPages =
        nextLimit > 0 ? Math.ceil(nextTotal / nextLimit) : 0;
      const serverPage = Number(json.page ?? targetPage);

      if (computedTotalPages > 0 && serverPage > computedTotalPages) {
        await loadPlaces(computedTotalPages, q);
        return;
      }

      setPlaces(nextPlaces);
      setCurrentPage(serverPage);
      setTotalRecords(nextTotal);
      setTotalPages(Number(json.totalPages ?? computedTotalPages));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function handleExport(format) {
    if (!exportUrl) {
      setError("Missing VITE_API_BASE_URL");
      showToast("Missing VITE_API_BASE_URL", "error");
      return;
    }
    try {
      const params = new URLSearchParams({ format });
      if (selectedIds.length > 0) {
        params.set("ids", selectedIds.join(","));
      }
      const response = await fetch(`${exportUrl}?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Export failed: ${response.status}`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `places.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      const target = selectedIds.length > 0 ? "selected records" : "all records";
      showToast(`Exported ${format.toUpperCase()} (${target})`, "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
    }
  }

  async function deleteSelected() {
    if (!bulkDeleteUrl) {
      setError("Missing VITE_API_BASE_URL");
      showToast("Missing VITE_API_BASE_URL", "error");
      return;
    }
    if (selectedIds.length === 0) {
      showToast("Please select at least one record", "info");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(bulkDeleteUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds })
      });
      if (!response.ok) {
        throw new Error(`Delete selected failed: ${response.status}`);
      }
      const payload = await response.json();
      const deleted = Number(payload.deleted || 0);
      showToast(`Deleted ${deleted} selected record(s)`, "success");
      setSelectedIds([]);
      await loadPlaces(currentPage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleSelect(id, checked) {
    setSelectedIds((prev) => {
      if (checked) {
        if (prev.includes(id)) return prev;
        return [...prev, id];
      }
      return prev.filter((v) => v !== id);
    });
  }

  function toggleSelectCurrentPage(checked) {
    const pageIds = places.map((place) => place.id).filter(Boolean);
    setSelectedIds((prev) => {
      const set = new Set(prev);
      if (checked) {
        pageIds.forEach((id) => set.add(id));
      } else {
        pageIds.forEach((id) => set.delete(id));
      }
      return Array.from(set);
    });
  }

  const currentPageIds = places.map((place) => place.id).filter(Boolean);
  const allCurrentPageSelected =
    currentPageIds.length > 0 && currentPageIds.every((id) => selectedIds.includes(id));

  async function handleImport() {
    if (!importUrl) {
      setError("Missing VITE_API_BASE_URL");
      showToast("Missing VITE_API_BASE_URL", "error");
      return;
    }
    if (!importFile) {
      showToast("Please choose CSV or XLSX file", "error");
      return;
    }

    const lower = importFile.name.toLowerCase();
    const format = lower.endsWith(".xlsx") ? "xlsx" : "csv";

    const formData = new FormData();
    formData.append("file", importFile);

    setImporting(true);
    setError("");
    try {
      const response = await fetch(`${importUrl}?format=${format}`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const payload = await response.json();
          throw new Error(payload.error || `Import failed: ${response.status}`);
        }
        throw new Error(`Import failed: ${response.status}`);
      }
      const payload = await response.json();
      const inserted = Number(payload.inserted || 0);
      showToast(`Imported ${inserted} records`, "success");
      setImportFile(null);
      await loadPlaces(1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setImporting(false);
    }
  }

  async function submitPlace(event) {
    event.preventDefault();
    if (!apiUrl) {
      setError("Missing VITE_API_BASE_URL");
      showToast("Missing VITE_API_BASE_URL", "error");
      return;
    }
    const lng = Number(form.lng);
    const lat = Number(form.lat);
    if (!form.name.trim() || Number.isNaN(lng) || Number.isNaN(lat)) {
      setError("Please provide name, longitude, and latitude");
      showToast("Please provide name, longitude, and latitude", "error");
      return;
    }

    setSubmitting(true);
    setError("");
    const isEdit = Boolean(editingId);
    try {
      const method = editingId ? "PATCH" : "POST";
      const url = editingId ? `${apiUrl}/${editingId}` : apiUrl;
      const body = editingId
        ? {
            properties: { name: form.name.trim() },
            geometry: { type: "Point", coordinates: [lng, lat] }
          }
        : {
            type: "Feature",
            geometry: { type: "Point", coordinates: [lng, lat] },
            properties: { name: form.name.trim() }
          };

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw new Error(`Save failed: ${response.status}`);
      }
      setForm({ name: "", lng: "", lat: "" });
      setEditingId("");
      setShowAddForm(false);
      if (draftMarkerRef.current) {
        draftMarkerRef.current.remove();
        draftMarkerRef.current = null;
      }
      if (clickPopupRef.current) {
        clickPopupRef.current.remove();
        clickPopupRef.current = null;
      }
      showToast(isEdit ? "Place updated" : "Place created", "success");
      if (isEdit) {
        await loadPlaces(currentPage);
      } else {
        await loadPlaces(1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(place) {
    setShowAddForm(false);
    setEditingId(place.id);
    setForm({
      name: place?.properties?.name || "",
      lng: String(place?.geometry?.coordinates?.[0] ?? ""),
      lat: String(place?.geometry?.coordinates?.[1] ?? "")
    });
  }

  function cancelEdit() {
    setEditingId("");
    setShowAddForm(false);
    setForm({ name: "", lng: "", lat: "" });
    if (draftMarkerRef.current) {
      draftMarkerRef.current.remove();
      draftMarkerRef.current = null;
    }
    if (clickPopupRef.current) {
      clickPopupRef.current.remove();
      clickPopupRef.current = null;
    }
  }

  async function deletePlace(placeId) {
    if (!apiUrl) {
      setError("Missing VITE_API_BASE_URL");
      showToast("Missing VITE_API_BASE_URL", "error");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${apiUrl}/${placeId}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Delete failed: ${response.status}`);
      }
      if (editingId === placeId) {
        cancelEdit();
      }
      showToast("Place deleted", "success");
      await loadPlaces(currentPage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await deletePlace(deleteTarget.id);
    setDeleteTarget(null);
  }

  function cancelDelete() {
    setDeleteTarget(null);
    showToast("Delete cancelled", "info");
  }

  function showOnMap(place) {
    if (!place?.id) return;
    setSelectedPlaceId(place.id);
    setViewMode("map");
    showToast(`Showing ${place?.properties?.name || "place"} on map`, "info");
  }

  function changeViewMode(mode) {
    setViewMode(mode);
    setSelectedPlaceId("");
    if (draftMarkerRef.current) {
      draftMarkerRef.current.remove();
      draftMarkerRef.current = null;
    }
    if (clickPopupRef.current) {
      clickPopupRef.current.remove();
      clickPopupRef.current = null;
    }
  }

  useEffect(() => {
    setCurrentPage(1);
    setFilterInput("");
    setAppliedFilter("");
    loadPlaces(1, "");
  }, [apiUrl]);

  function goToPage(nextPage) {
    if (loading || submitting) return;
    if (nextPage < 1 || (totalPages > 0 && nextPage > totalPages)) return;
    loadPlaces(nextPage);
  }

  function applyNameFilter() {
    const next = filterInput.trim();
    setAppliedFilter(next);
    loadPlaces(1, next);
  }

  function clearNameFilter() {
    setFilterInput("");
    setAppliedFilter("");
    loadPlaces(1, "");
  }

  function openAddForm() {
    setEditingId("");
    setForm({ name: "", lng: "", lat: "" });
    setShowAddForm(true);
  }

  createPlaceFromMapRef.current = async (lng, lat, name) => {
    if (!apiUrl) {
      showToast("Missing VITE_API_BASE_URL", "error");
      return false;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      showToast("Please enter a place name", "error");
      return false;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lng, lat] },
          properties: { name: trimmed }
        })
      });
      if (!response.ok) {
        throw new Error(`Save failed: ${response.status}`);
      }
      showToast("Place created", "success");
      await loadPlaces(1);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (viewMode !== "map") return;
    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    const points = extractPointCoordinates(places);
    const initialCenter = points.length > 0 ? points[0] : [100.5018, 13.7563];
    const initialZoom = points.length > 0 ? 10 : 5;

    mapRef.current = new maplibregl.Map({
      container: mapContainerRef.current,
      style: DEFAULT_MAP_STYLE,
      center: initialCenter,
      zoom: initialZoom
    });

    const handleMapClick = (event) => {
      const target = event.originalEvent?.target;
      if (target && target.closest && target.closest(".map-marker-wrap")) {
        return;
      }

      const lng = Number(event.lngLat.lng.toFixed(6));
      const lat = Number(event.lngLat.lat.toFixed(6));

      let nearest = null;
      placesRef.current.forEach((place) => {
        const coords = place?.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) return;
        const pLng = Number(coords[0]);
        const pLat = Number(coords[1]);
        if (Number.isNaN(pLng) || Number.isNaN(pLat)) return;
        const meters = distanceMeters(lat, lng, pLat, pLng);
        if (!nearest || meters < nearest.meters) {
          nearest = {
            name: place?.properties?.name || "Unnamed place",
            meters
          };
        }
      });

      const isExactExistingPoint = nearest && nearest.meters <= 8;
      if (clickPopupRef.current) {
        clickPopupRef.current.remove();
      }

      if (isExactExistingPoint) {
        if (draftMarkerRef.current) {
          draftMarkerRef.current.remove();
          draftMarkerRef.current = null;
        }
        showToast("Clicked existing place", "info");
        return;
      }

      if (draftMarkerRef.current) {
        draftMarkerRef.current.remove();
      }
      const draftEl = document.createElement("div");
      draftEl.className = "map-marker map-marker-draft";
      draftMarkerRef.current = new maplibregl.Marker({ element: draftEl })
        .setLngLat([lng, lat])
        .addTo(mapRef.current);

      const container = document.createElement("div");
      container.className = "map-popup-add";

      const coordsLine = document.createElement("p");
      coordsLine.className = "map-popup-coords";
      coordsLine.textContent = `lat ${lat}, lon ${lng}`;

      const input = document.createElement("input");
      input.type = "text";
      input.className = "map-popup-input";
      input.placeholder = "Place name";
      input.setAttribute("autocomplete", "off");

      const actions = document.createElement("div");
      actions.className = "map-popup-actions";

      const btnCancel = document.createElement("button");
      btnCancel.type = "button";
      btnCancel.className = "map-popup-btn map-popup-btn-cancel";
      btnCancel.textContent = "Cancel";

      const btnAdd = document.createElement("button");
      btnAdd.type = "button";
      btnAdd.className = "map-popup-btn map-popup-btn-primary";
      btnAdd.textContent = "Add";

      actions.appendChild(btnCancel);
      actions.appendChild(btnAdd);
      container.appendChild(coordsLine);
      container.appendChild(input);
      container.appendChild(actions);

      const clearDraft = () => {
        if (draftMarkerRef.current) {
          draftMarkerRef.current.remove();
          draftMarkerRef.current = null;
        }
      };

      const closePopup = () => {
        if (clickPopupRef.current) {
          clickPopupRef.current.remove();
          clickPopupRef.current = null;
        }
        clearDraft();
      };

      btnCancel.addEventListener("click", closePopup);

      btnAdd.addEventListener("click", async () => {
        const ok = await createPlaceFromMapRef.current(lng, lat, input.value);
        if (!ok) return;
        if (clickPopupRef.current) {
          clickPopupRef.current.remove();
        }
      });

      const popup = new maplibregl.Popup({
        offset: 20,
        closeButton: true,
        closeOnClick: false
      })
        .setLngLat([lng, lat])
        .setDOMContent(container)
        .addTo(mapRef.current);

      clickPopupRef.current = popup;
      popup.on("close", () => {
        clearDraft();
        clickPopupRef.current = null;
      });

      window.setTimeout(() => {
        input.focus();
      }, 0);
    };

    mapRef.current.on("click", handleMapClick);

    return () => {
      if (mapRef.current) {
        mapRef.current.off("click", handleMapClick);
      }
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      if (draftMarkerRef.current) {
        draftMarkerRef.current.remove();
        draftMarkerRef.current = null;
      }
      if (clickPopupRef.current) {
        clickPopupRef.current.remove();
        clickPopupRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [viewMode]);

  useEffect(() => {
    if (!mapRef.current) return;

    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
    markerByIdRef.current = {};

    const bounds = new maplibregl.LngLatBounds();
    let pointCount = 0;

    places.forEach((place) => {
      const coords = place?.geometry?.coordinates;
      const name = place?.properties?.name || "Unnamed place";
      if (!Array.isArray(coords) || coords.length < 2) return;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (Number.isNaN(lng) || Number.isNaN(lat)) return;

      const markerWrapEl = document.createElement("div");
      markerWrapEl.className = "map-marker-wrap";

      const markerDotEl = document.createElement("button");
      markerDotEl.type = "button";
      markerDotEl.className = "map-marker";
      markerDotEl.setAttribute("aria-label", name);

      const markerLabelEl = document.createElement("span");
      markerLabelEl.className = "map-marker-label";
      markerLabelEl.textContent = name;

      markerWrapEl.appendChild(markerDotEl);
      markerWrapEl.appendChild(markerLabelEl);

      const marker = new maplibregl.Marker({ element: markerWrapEl })
        .setLngLat([lng, lat])
        .setPopup(
          new maplibregl.Popup({ offset: 24 }).setHTML(
            `<div><strong>${name}</strong><br/>lat: ${lat}<br/>lon: ${lng}</div>`
          )
        )
        .addTo(mapRef.current);

      markersRef.current.push(marker);
      markerByIdRef.current[place.id] = marker;
      bounds.extend([lng, lat]);
      pointCount += 1;
    });

    if (pointCount > 1) {
      mapRef.current.fitBounds(bounds, { padding: 60, maxZoom: 12 });
    } else if (pointCount === 1) {
      const center = bounds.getCenter();
      mapRef.current.flyTo({ center, zoom: 12 });
    }
  }, [places, viewMode]);

  useEffect(() => {
    if (viewMode !== "map") return;
    if (!selectedPlaceId) return;
    if (!mapRef.current) return;

    const target = places.find((place) => place.id === selectedPlaceId);
    const coords = target?.geometry?.coordinates;
    if (!target || !Array.isArray(coords) || coords.length < 2) return;

    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isNaN(lng) || Number.isNaN(lat)) return;

    mapRef.current.flyTo({ center: [lng, lat], zoom: 13 });
    const marker = markerByIdRef.current[selectedPlaceId];
    if (marker) {
      marker.togglePopup();
    }
  }, [places, selectedPlaceId, viewMode]);

  return (
    <main className="page">
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.message}
          </div>
        ))}
      </div>
      <header className="header">
        <h1>Mini Spatial Data</h1>
        {/* <p>Places list from backend API</p> */}
      </header>

      <section className="panel">
        {deleteTarget && (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="modal-card">
              <h3>Delete place?</h3>
              <p>
                Are you sure you want to delete{" "}
                <strong>{deleteTarget.name || "this place"}</strong>?
              </p>
              <div className="modal-actions">
                <button type="button" onClick={cancelDelete} disabled={submitting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={confirmDelete}
                  disabled={submitting}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="view-switch">
          <button
            type="button"
            className={viewMode === "table" ? "active" : ""}
            onClick={() => changeViewMode("table")}
          >
            Table
          </button>
          <button
            type="button"
            className={viewMode === "map" ? "active" : ""}
            onClick={() => changeViewMode("map")}
          >
            Map
          </button>
        </div>

        {loading && <p>Loading...</p>}
        {error && <p className="error">Error: {error}</p>}
        {viewMode === "table" && (
          <>
            <div className="panel-title">
              <h2>Places</h2>
              <button type="button" className="btn-primary" onClick={openAddForm} disabled={loading || submitting}>
                Add place
              </button>
            </div>
            <div className="filter-row">
              <input
                type="search"
                className="filter-input"
                placeholder="Filter by name (contains)"
                value={filterInput}
                onChange={(e) => setFilterInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyNameFilter();
                }}
                disabled={loading || submitting}
              />
              <button type="button" onClick={applyNameFilter} disabled={loading || submitting}>
                Search
              </button>
              <button type="button" onClick={clearNameFilter} disabled={loading || submitting}>
                Clear
              </button>
            </div>
            <div className="data-tools">
              <div className="export-tools">
                <button type="button" onClick={() => handleExport("csv")} disabled={loading || submitting || importing}>
                  Export CSV
                </button>
                <button type="button" onClick={() => handleExport("xlsx")} disabled={loading || submitting || importing}>
                  Export XLSX
                </button>
                <button type="button" onClick={deleteSelected} disabled={loading || submitting || importing || selectedIds.length === 0}>
                  Delete Selected ({selectedIds.length})
                </button>
              </div>
              <div className="import-tools">
                <input
                  type="file"
                  accept=".csv,.xlsx"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                  disabled={loading || submitting || importing}
                />
                <button type="button" onClick={handleImport} disabled={loading || submitting || importing}>
                  {importing ? "Importing..." : "Import File"}
                </button>
              </div>
            </div>
            {(showAddForm || editingId) && (
              <form className="place-form" onSubmit={submitPlace}>
                <input
                  type="text"
                  placeholder="Place name"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                />
                <input
                  type="number"
                  step="any"
                  placeholder="Longitude"
                  value={form.lng}
                  onChange={(e) => setForm((prev) => ({ ...prev, lng: e.target.value }))}
                />
                <input
                  type="number"
                  step="any"
                  placeholder="Latitude"
                  value={form.lat}
                  onChange={(e) => setForm((prev) => ({ ...prev, lat: e.target.value }))}
                />
                <button type="submit" disabled={submitting}>
                  {editingId ? "Update" : "Add"}
                </button>
                {(editingId || showAddForm) && (
                  <button type="button" onClick={cancelEdit} disabled={submitting}>
                    Cancel
                  </button>
                )}
              </form>
            )}
            <p className="map-help">
              Tip: open Map and click the map to add a place — type the name in the popup and press Add.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={allCurrentPageSelected}
                        onChange={(e) => toggleSelectCurrentPage(e.target.checked)}
                      />
                    </th>
                    <th>Name</th>
                    <th>Longitude</th>
                    <th>Latitude</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {places.length === 0 && (
                    <tr>
                      <td colSpan={5}>No places found</td>
                    </tr>
                  )}
                  {places.map((place) => (
                    <tr key={place.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(place.id)}
                          onChange={(e) => toggleSelect(place.id, e.target.checked)}
                        />
                      </td>
                      <td>{place?.properties?.name || "-"}</td>
                      <td>{place?.geometry?.coordinates?.[0] ?? "-"}</td>
                      <td>{place?.geometry?.coordinates?.[1] ?? "-"}</td>
                      <td className="actions">
                        <button
                          type="button"
                          onClick={() => showOnMap(place)}
                          disabled={submitting}
                        >
                          Show on map
                        </button>
                        <button
                          type="button"
                          onClick={() => startEdit(place)}
                          disabled={submitting}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget({
                              id: place.id,
                              name: place?.properties?.name || ""
                            })
                          }
                          disabled={submitting}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                Showing {places.length} of {totalRecords} records
              </span>
              <button
                type="button"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1 || loading || submitting}
              >
                Previous
              </button>
              <span>
                Page {totalPages === 0 ? 0 : currentPage} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => goToPage(currentPage + 1)}
                disabled={totalPages === 0 || currentPage >= totalPages || loading || submitting}
              >
                Next
              </button>
            </div>
          </>
        )}

        {viewMode === "map" && (
          <>
            <p className="map-view-hint">Click the map to add a place — enter the name in the popup and tap Add.</p>
            <div ref={mapContainerRef} className="map-container map-container-full" />
          </>
        )}
      </section>
    </main>
  );
}

export default App;
