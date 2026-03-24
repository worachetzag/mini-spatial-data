import React, { useEffect, useMemo, useState } from "react";
import maplibregl from "maplibre-gl";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL;

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

function App() {
  const [places, setPlaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [viewMode, setViewMode] = useState("table");
  const [form, setForm] = useState({
    name: "",
    lng: "",
    lat: ""
  });
  const [editingId, setEditingId] = useState("");
  const mapContainerRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const markersRef = React.useRef([]);

  const apiUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/places` : ""),
    []
  );

  async function loadPlaces() {
    setLoading(true);
    setError("");
    if (!apiUrl) {
      setLoading(false);
      setError("Missing VITE_API_BASE_URL");
      return;
    }
    if (!MAP_STYLE_URL) {
      setLoading(false);
      setError("Missing VITE_MAP_STYLE_URL");
      return;
    }
    try {
      const response = await fetch(apiUrl);
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const json = await response.json();
      setPlaces(Array.isArray(json.data) ? json.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function submitPlace(event) {
    event.preventDefault();
    if (!apiUrl) {
      setError("Missing VITE_API_BASE_URL");
      return;
    }
    const lng = Number(form.lng);
    const lat = Number(form.lat);
    if (!form.name.trim() || Number.isNaN(lng) || Number.isNaN(lat)) {
      setError("Please provide name, longitude, and latitude");
      return;
    }

    setSubmitting(true);
    setError("");
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
      await loadPlaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(place) {
    setEditingId(place.id);
    setForm({
      name: place?.properties?.name || "",
      lng: String(place?.geometry?.coordinates?.[0] ?? ""),
      lat: String(place?.geometry?.coordinates?.[1] ?? "")
    });
  }

  function cancelEdit() {
    setEditingId("");
    setForm({ name: "", lng: "", lat: "" });
  }

  async function deletePlace(placeId) {
    if (!apiUrl) {
      setError("Missing VITE_API_BASE_URL");
      return;
    }
    const ok = window.confirm("Delete this place?");
    if (!ok) return;
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
      await loadPlaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    loadPlaces();
  }, [apiUrl]);

  useEffect(() => {
    if (viewMode !== "map") return;
    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    const points = extractPointCoordinates(places);
    const initialCenter = points.length > 0 ? points[0] : [100.5018, 13.7563];
    const initialZoom = points.length > 0 ? 10 : 5;

    mapRef.current = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE_URL,
      center: initialCenter,
      zoom: initialZoom
    });

    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-right");

    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [places, viewMode]);

  useEffect(() => {
    if (!mapRef.current) return;

    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];

    const bounds = new maplibregl.LngLatBounds();
    let pointCount = 0;

    places.forEach((place) => {
      const coords = place?.geometry?.coordinates;
      const name = place?.properties?.name || "Unnamed place";
      if (!Array.isArray(coords) || coords.length < 2) return;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (Number.isNaN(lng) || Number.isNaN(lat)) return;

      const marker = new maplibregl.Marker()
        .setLngLat([lng, lat])
        .setPopup(new maplibregl.Popup({ offset: 24 }).setText(name))
        .addTo(mapRef.current);

      markersRef.current.push(marker);
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

  return (
    <main className="page">
      <header className="header">
        <h1>Mini Spatial Data</h1>
        <p>Places list from backend API</p>
      </header>

      <section className="panel">
        <div className="panel-title">
          <h2>Places</h2>
          <span className="count">{places.length} records</span>
        </div>
        <div className="view-switch">
          <button
            type="button"
            className={viewMode === "table" ? "active" : ""}
            onClick={() => setViewMode("table")}
          >
            Table
          </button>
          <button
            type="button"
            className={viewMode === "map" ? "active" : ""}
            onClick={() => setViewMode("map")}
          >
            Map
          </button>
        </div>

        {loading && <p>Loading...</p>}
        {error && <p className="error">Error: {error}</p>}
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
          {editingId && (
            <button type="button" onClick={cancelEdit} disabled={submitting}>
              Cancel
            </button>
          )}
        </form>

        {!loading && !error && viewMode === "table" && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Longitude</th>
                <th>Latitude</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {places.length === 0 && (
                <tr>
                  <td colSpan={4}>No places found</td>
                </tr>
              )}
              {places.map((place) => (
                <tr key={place.id}>
                  <td>{place?.properties?.name || "-"}</td>
                  <td>{place?.geometry?.coordinates?.[0] ?? "-"}</td>
                  <td>{place?.geometry?.coordinates?.[1] ?? "-"}</td>
                  <td className="actions">
                    <button
                      type="button"
                      onClick={() => startEdit(place)}
                      disabled={submitting}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePlace(place.id)}
                      disabled={submitting}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && !error && viewMode === "map" && (
          <div ref={mapContainerRef} className="map-container" />
        )}
      </section>
    </main>
  );
}

export default App;
