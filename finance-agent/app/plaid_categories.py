"""
Maps Plaid's personal_finance_category (primary + detailed) to ledger-app's own categories,
for the review queue's suggested_category. Anything without a reasonable match becomes
"Other"; the household picks the real category when reviewing.

ledger-app's categories live in src/main.js (CATEGORIES). tests/test_plaid.py reads that
file and fails if any category named here isn't one of them, so the two can't drift.
"""

# Detailed category → ours. Checked first.
EXPENSE_DETAILED = {
    "RENT_AND_UTILITIES_RENT": "Rent / Mortgage",
    "LOAN_PAYMENTS_MORTGAGE_PAYMENT": "Rent / Mortgage",
    "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY": "Electricity & gas",
    "RENT_AND_UTILITIES_WATER": "Water & trash",
    "RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT": "Water & trash",
    "RENT_AND_UTILITIES_INTERNET_AND_CABLE": "Internet & phone",
    "RENT_AND_UTILITIES_TELEPHONE": "Internet & phone",
    "RENT_AND_UTILITIES_OTHER_UTILITIES": "Other bills",
    "HOME_IMPROVEMENT_FURNITURE": "Furniture & home goods",
    "HOME_IMPROVEMENT_HARDWARE": "Home maintenance",
    "HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE": "Home maintenance",
    "HOME_IMPROVEMENT_SECURITY": "Home maintenance",
    "HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT": "Home maintenance",
    "FOOD_AND_DRINK_GROCERIES": "Groceries",
    "FOOD_AND_DRINK_COFFEE": "Coffee",
    "FOOD_AND_DRINK_RESTAURANT": "Restaurants & takeout",
    "FOOD_AND_DRINK_FAST_FOOD": "Restaurants & takeout",
    "TRANSPORTATION_GAS": "Fuel",
    "TRANSPORTATION_PUBLIC_TRANSIT": "Public transit",
    "TRANSPORTATION_TAXIS_AND_RIDE_SHARES": "Rideshare & taxi",
    "TRANSPORTATION_PARKING": "Parking & tolls",
    "TRANSPORTATION_TOLLS": "Parking & tolls",
    "LOAN_PAYMENTS_CAR_PAYMENT": "Car payment",
    "GENERAL_SERVICES_AUTOMOTIVE": "Car maintenance",
    "MEDICAL_DENTAL_CARE": "Medical & dental",
    "MEDICAL_EYE_CARE": "Medical & dental",
    "MEDICAL_PRIMARY_CARE": "Medical & dental",
    "MEDICAL_NURSING_CARE": "Medical & dental",
    "MEDICAL_PHARMACIES_AND_SUPPLEMENTS": "Pharmacy",
    "MEDICAL_VETERINARY_SERVICES": "Pets",
    "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS": "Fitness",
    "PERSONAL_CARE_HAIR_AND_BEAUTY": "Hair & beauty",
    "PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING": "Laundry & dry cleaning",
    "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES": "Clothing",
    "GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS": "Books & supplies",
    "GENERAL_MERCHANDISE_OFFICE_SUPPLIES": "Books & supplies",
    "GENERAL_MERCHANDISE_PET_SUPPLIES": "Pets",
    "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES": "Gifts given",
    "GENERAL_SERVICES_CHILDCARE": "Childcare",
    "GENERAL_SERVICES_EDUCATION": "Courses",
    "GENERAL_SERVICES_INSURANCE": "Other bills",
    "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT": "Loan & card payments",
    "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT": "Loan & card payments",
    "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT": "Loan & card payments",
    "LOAN_PAYMENTS_OTHER_PAYMENT": "Loan & card payments",
    "BANK_FEES_OVERDRAFT_FEES": "Bank fees",
    "BANK_FEES_ATM_FEES": "Bank fees",
    "BANK_FEES_FOREIGN_TRANSACTION_FEES": "Bank fees",
    "BANK_FEES_INSUFFICIENT_FUNDS": "Bank fees",
    "BANK_FEES_INTEREST_CHARGE": "Bank fees",
    "BANK_FEES_OTHER_BANK_FEES": "Bank fees",
    "GOVERNMENT_AND_NON_PROFIT_DONATIONS": "Donations",
    "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT": "Taxes",
    "GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES": "Government fees",
}

# Primary category → ours, when the detailed one isn't listed above.
EXPENSE_PRIMARY = {
    "RENT_AND_UTILITIES": "Other bills",
    "HOME_IMPROVEMENT": "Home maintenance",
    "FOOD_AND_DRINK": "Restaurants & takeout",
    "TRANSPORTATION": "Other transportation",
    "TRAVEL": "Travel",
    "MEDICAL": "Other health",
    "PERSONAL_CARE": "Hair & beauty",
    "GENERAL_MERCHANDISE": "Shopping",
    "ENTERTAINMENT": "Entertainment",
    "LOAN_PAYMENTS": "Loan & card payments",
    "BANK_FEES": "Bank fees",
}

INCOME_DETAILED = {
    "INCOME_WAGES": "Salary",
    "INCOME_DIVIDENDS": "Investments & interest",
    "INCOME_INTEREST_EARNED": "Investments & interest",
    "INCOME_RETIREMENT_PENSION": "Benefits",
    "INCOME_UNEMPLOYMENT": "Benefits",
    "INCOME_TAX_REFUND": "Refunds & reimbursements",
}

# Money in whose category isn't income or a transfer (a purchase category on a credit) is
# almost always a refund.
NOT_A_REFUND_PRIMARY = {"INCOME", "TRANSFER_IN", "TRANSFER_OUT"}


def suggest_category(pfc: dict | None, txn_type: str) -> str:
    """Our closest category for a Plaid personal_finance_category, for this txn_type
    ("income" or "expense"), or "Other"."""
    pfc = pfc or {}
    primary = pfc.get("primary") or ""
    detailed = pfc.get("detailed") or ""
    if txn_type == "income":
        if detailed in INCOME_DETAILED:
            return INCOME_DETAILED[detailed]
        if primary and primary not in NOT_A_REFUND_PRIMARY:
            return "Refunds & reimbursements"
        return "Other"
    return EXPENSE_DETAILED.get(detailed) or EXPENSE_PRIMARY.get(primary) or "Other"
