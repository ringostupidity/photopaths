from flask import Flask, render_template, request, jsonify
from supabase import create_client, Client
import requests
import os

# Folder structure:
#
# photopaths/
# ├── app.py
# ├── templates/
# │   └── index.html
# └── static/
#     ├── css/
#     ├── js/
#     └── images/

app = Flask(
    __name__,
    template_folder="templates",
    static_folder="static"
)


# -------------------------
# Supabase
# -------------------------

url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")

supabase: Client | None = None

if url and key:
    supabase = create_client(url, key)


# -------------------------
# Pages
# -------------------------

@app.route("/")
def home():
    return render_template("index.html")


# -------------------------
# Test endpoints
# -------------------------

@app.route("/api/test")
def test():
    return jsonify({"message": "Flask is working!"})


@app.route("/test-report")
def test_report():

    if supabase is None:
        return jsonify({
            "error": "Supabase environment variables are not configured."
        }), 500

    response = (
        supabase
        .table("reports")
        .insert({
            "latitude": 33.91,
            "longitude": -117.89,
            "report_type": "broken_light",
            "description": "Testing PhotoPath reporting"
        })
        .execute()
    )

    return jsonify({
        "message": "Report saved!",
        "data": response.data
    })


# -------------------------
# Geocoding
# -------------------------

@app.route("/api/geocode", methods=["POST"])
def geocode():

    data = request.get_json()

    if not data or not data.get("query"):
        return jsonify({
            "error": "Please enter a destination."
        }), 400

    response = requests.get(
        "https://nominatim.openstreetmap.org/search",
        params={
            "q": data["query"],
            "format": "json",
            "limit": 1
        },
        headers={
            "User-Agent": "PhotoPath/1.0"
        },
        timeout=10
    )

    results = response.json()

    if not results:
        return jsonify({
            "error": "Destination not found."
        }), 404

    place = results[0]

    return jsonify({
        "lat": float(place["lat"]),
        "lon": float(place["lon"]),
        "name": place["display_name"]
    })


# -------------------------
# Routing
# -------------------------

@app.route("/api/route", methods=["POST"])
def route():

    data = request.get_json()

    if not data or not data.get("start") or not data.get("end"):
        return jsonify({
            "error": "Starting location and destination are required."
        }), 400

    start = data["start"]
    end = data["end"]

    coordinates = (
        f"{start['lon']},{start['lat']};"
        f"{end['lon']},{end['lat']}"
    )

    response = requests.get(
        f"https://router.project-osrm.org/route/v1/driving/{coordinates}",
        params={
            "overview": "full",
            "geometries": "geojson",
            "alternatives": "true"
        },
        timeout=15
    )

    route_data = response.json()

    if route_data.get("code") != "Ok":
        return jsonify({
            "error": "Could not calculate a route."
        }), 400

    routes = []

    for index, route in enumerate(route_data["routes"]):
        routes.append({
            "label": (
                "Recommended route"
                if index == 0
                else "Alternative route"
            ),
            "duration": round(route["duration"] / 60),
            "distance": route["distance"],
            "score": 0,
            "geometry": route["geometry"]
        })

    return jsonify({"routes": routes})


# -------------------------
# Start server
# -------------------------

if __name__ == "__main__":
    print("PhotoPath server running")
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=True
    )