-- Run in the Supabase SQL editor on a project created before this change (new projects get it from schema.sql). Safe to run again.
-- The daily (1D) bars of the stocks of the strategy chosen for the daily import are saved in their own collection, priceHistory1D (one document per stock, like
-- priceHistory). They are shared stock data like the weekly and monthly bars: Pro and trial users and the owner read them, and only the owner writes them
-- (the owner policy already covers every shared path). Nothing else changes.
drop policy if exists shared_read_pro on public.docs;
create policy shared_read_pro on public.docs for select to authenticated
  using ((path like 'stockData/%' or path like 'stockResearch/%' or path like 'priceHistory/%' or path like 'priceHistory1D/%') and public.has_pro());
