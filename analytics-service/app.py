from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import analytics

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/analytics/health")
def health_check():
    return {"status": "ok", "message": "Analytics service is running"}

@app.get("/api/analytics/revenue")
def get_revenue():
    return analytics.calculate_total_revenue()

@app.get("/api/analytics/top-products")
def get_top_products(limit: int = 5):
    return analytics.get_top_products(limit)

@app.get("/api/analytics/trend")
def get_sales_trend(days: int = 7):
    return analytics.get_sales_trend(days)

@app.get("/api/analytics/unique/{field}")
def get_unique_values(field: str):
    return analytics.get_unique_values(field)

@app.get("/api/analytics/sales-by/{field}/{value}")
def get_sales_by_filter(field: str, value: str):
    return analytics.get_sales_by_filter(field, value)
