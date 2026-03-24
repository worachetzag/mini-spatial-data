import React, { useEffect, useMemo, useState } from "react";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

function App() {
  const [places, setPlaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const apiUrl = useMemo(() => `${API_BASE_URL}/api/places`, []);

  useEffect(() => {
    let active = true;

    async function loadPlaces() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(apiUrl);
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }
        const json = await response.json();
        if (!active) return;
        setPlaces(Array.isArray(json.data) ? json.data : []);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (active) setLoading(false);
      }
    }

    loadPlaces();
    return () => {
      active = false;
    };
  }, [apiUrl]);

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

        {loading && <p>Loading...</p>}
        {error && <p className="error">Error: {error}</p>}

        {!loading && !error && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Longitude</th>
                <th>Latitude</th>
              </tr>
            </thead>
            <tbody>
              {places.length === 0 && (
                <tr>
                  <td colSpan={3}>No places found</td>
                </tr>
              )}
              {places.map((place) => (
                <tr key={place.id}>
                  <td>{place?.properties?.name || "-"}</td>
                  <td>{place?.geometry?.coordinates?.[0] ?? "-"}</td>
                  <td>{place?.geometry?.coordinates?.[1] ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

export default App;
