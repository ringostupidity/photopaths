from flask import Flask, render_template

app = Flask(__name__)

@app.route("/")
def home():
    return render_template("index.html")

if __name__ == "__main__":
    app.run(debug=True)

import os

from supabase import create_client, Client

app = Flask(__name__)

url = os.environ.get("https://gpkwqhlqkpkjtdpnfvdx.supabase.co")
key = os.environ.get("sb_publishable_osB3mT4QjTEONufpvET4tQ_IvwR6UsC")

supabase: Client = create_client(url, key)

@app.route("/")
def home():
    return render_template("index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)

@app.route("/test-report")
def test_report():

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

    return {
        "message": "Report saved!",
        "data": response.data
    }

from flask import request, jsonify, send_from_directory
import requests

app = Flask(__name__)


# Serve map.html
@app.route("/")
def home():
    #return send_from_directory(".", "index.html")
    return "running"

# Test endpoint
@app.route("/api/test")
def test():
    return "working"
    #return jsonify({"message": "Flask is working!"})


# Geocode a destination
@app.route("/api/geocode", methods=["POST"])
def geocode():
    data = request.get_json()

    if not data or not data.get("query"):
        return jsonify({"error": "Please enter a destination."}), 400

    query = data["query"]

    response = requests.get(
        "https://nominatim.openstreetmap.org/search",
        params={
            "q": query,
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
        return jsonify({"error": "Destination not found."}), 404

    place = results[0]

    return jsonify({
        "lat": float(place["lat"]),
        "lon": float(place["lon"]),
        "name": place["display_name"]
    })


# Calculate a route
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
            "label": "Recommended route" if index == 0 else "Alternative route",
            "duration": round(route["duration"] / 60),
            "distance": route["distance"],
            "score": 0,
            "geometry": route["geometry"]
        })

    return jsonify({"routes": routes})


if __name__ == "__main__":
    print("TEST ROUTE LOADED")
    app.run(debug=True)