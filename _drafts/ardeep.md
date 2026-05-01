---
title: How to build your own active reocord db connector
mermaid: true
date: 2026-04-02 10:00:00 +0200
categories: [dev, ruby]
tags: [ruby, activerecord, database]     # TAG names should always be lowercase
---

# Extend the ActiveRecord::ConnectionAdapters

The active record source code help us to understand how the existing adapter works, activerecord natively support *psotgrtresql*, *slqlite3* and *mysql2*. We can see that they all inherit from the `ActiveRecord::ConnectionAdapters::AbstractAdapter`.
Globally, the `ActiveRecord::ConnectionAdapters` have a set of classes used to handle the interaction with the database. The activerecord team did a great work to minimise the job to be done when implementing those abastract classes. The idea is to focus only on methods that is explicitaly to implement, marked by the error: *NotImplementedError*

```ruby
# activerecord/lib/active_record/connection_adapters/abstract/schema_statements.rb

# Returns an array of indexes for the given table.
def indexes(table_name)
  raise NotImplementedError, "#indexes is not implemented"
end
)
```

# Register your adapter

That is one of the easier part. Here we want to add one for our specific connector.
All we have to do is to add it to the *@adapters* hash by calling the `ActiveRecord::ConnectionAdapters` register method.

```ruby
  ActiveRecord::Base.establish_connection(
    adapter: 'arconnector',
    database: ':memory:'
  )
```

By convention, the call is placed in the extension of the `ActiveRecord::ConnectionAdapters`  module to be call when loaded. 

```ruby
# ..active_record/connection_adapters/ar_connector.rb

module ActiveRecord
  module ConnectionAdapters
    register("arconnector", "ActiveRecord::ConnectionAdapters::ArConnector", "active_record/connection_adapters/ar_connector")
  end
end
```

# Let be serious, create a table

So our goal is to create our first table using the schema, and implement the essentials functionalties.
For the example sake, we will connect to an sqlite database, but with our own implementation.

```ruby
  ActiveRecord::Schema.define do
    create_table :shows, force: true do |t|
      t.string :name
    end
  end
```

## Initiate the connection

First we have to initialize the connection. In the activerecord it lay in the varaible @raw_connection. The key method to set is not a *connected* method, but the *reconnect* one, as it is called each time a connection need to be set or reset.

```ruby
  def reconnect
    @raw_connection = ::SQLite3::Database.new(":memory:")
  end
```

## Quoting

Every generated SQL is sanitized. Abstract adapter already provide most of transformation needed to avoid any injection, at the exception of *quoting*. By default, every quoting are done the same way and lay in `quote_column_name`. A look in the abstract code show that is refered by `quote_table_name`. Here is an exemple of a method with no `raise NotImplementedError` that might be needed to be overide if your db have a different rule of quoting for table or column. In general db specificity might imply to overload the abstract method.

Again, as a convention, the quoting logics are set in a module `Quoting` included by our adapter

```ruby
module ActiveRecord
  module ConnectionAdapters
    module ArAdapter
      module Quoting # :nodoc:
        extend ActiveSupport::Concern # :nodoc:
        module ClassMethods # :nodoc:
          def quote_column_name(column_name)
            %Q("#{column_name.to_s.gsub('"', '""')}")
          end
        end
      end
    end
  end
end
```

## Type matching

Another element to define, is how we translate an activerecord type into a SQL type. In our exemple, the `name` column is defined to be a `string`.
This matching is return by the class method `native_database_types`, a hash with as a key the activerecord symbole of the type, and as a value, either a string or an hash with the mandatory key `:name` and optionaly `:limit`, `:precision` and `:scale`.

```ruby
  def native_database_types
    {
      primary_key:  "integer PRIMARY KEY AUTOINCREMENT NOT NULL",
      string:       { name: "varchar" },
      text:         { name: "text" },
      integer:      { name: "integer" },
      float:        { name: "float" },
      decimal:      { name: "decimal" },
      datetime:     { name: "datetime" },
      time:         { name: "time" },
      date:         { name: "date" },
      binary:       { name: "blob" },
      boolean:      { name: "boolean" },
      json:         { name: "json" },
    }
  end
```

## Schema Statements

To properly work with our database we need to have access to its metadata, know if a table already exists.

For instance, we may need a list of table, the method is described by :

```ruby
# Returns an array of table names defined in the database.
def tables
  query_values(data_source_sql(type: "BASE TABLE"))
end
```

The logic is all set in the `data_source_sql`

By convention every Schema Statements methods is defined in *SchemaStatements* module

```ruby
module ActiveRecord
  module ConnectionAdapters
    module ArAdapter
      module SchemaStatements # :nodoc:
        def data_source_sql(name = nil, type: nil)
          scope = quoted_scope(name, type: type)
          scope[:type] ||= "'table','view'"

          sql = +"SELECT name FROM pragma_table_list WHERE schema <> 'temp'"
          sql << " AND name NOT IN ('sqlite_sequence', 'sqlite_schema')"
          sql << " AND name = #{scope[:name]}" if scope[:name]
          sql << " AND type IN (#{scope[:type]})"
          sql
        end

        def quoted_scope(name = nil, type: nil)
          type = \
            case type
            when "BASE TABLE"
              "'table'"
            when "VIEW"
              "'view'"
            when "VIRTUAL TABLE"
              "'virtual'"
            end
          scope = {}
          scope[:name] = quote(name) if name
          scope[:type] = type if type
          scope
        end
      end
    end
  end
end
```

## Database statement to actually do stuff

With all the previous precaution set, now we have to do the minimum to actually execute queries on the database.
In our exemple, we first check the existence of the table (already done in schema statement) and run the internale execution: 

```ruby
  def internal_execute(sql, name = "SQL", binds = [], prepare: false, async: false, allow_retry: false, materialize_transactions: true, &block)
    sql = preprocess_query(sql)
    raw_execute(sql, name, binds, prepare: prepare, async: async, allow_retry: allow_retry, materialize_transactions: materialize_transactions, &block)
  end
```

In the `preprocess` we define if the query is a write query and so need a specific lock, and run the `raw_execute`. We have to implement `write_query?`, `perform_query` and `cast_result`.

```ruby
module ActiveRecord
  module ConnectionAdapters
    module ArAdapter
      module DatabaseStatements
        def write_query?(sql)
          read_query = ActiveRecord::ConnectionAdapters::AbstractAdapter.build_read_query_regexp(
                    :pragma
                  ) # :nodoc:
          !read_query.match?(sql)
        end

        # Directly from sqlite3 connector, as the logic is specific to sqlite
        def perform_query(raw_connection, sql, binds, type_casted_binds, prepare:, notification_payload:, batch:)
          total_changes_before_query = raw_connection.total_changes
          affected_rows = nil

          stmt = raw_connection.prepare(sql)
          begin
            result = if stmt.column_count.zero? # No return
              stmt.step

              affected_rows = if raw_connection.total_changes > total_changes_before_query
                raw_connection.changes
              else
                0
              end

              ActiveRecord::Result.empty(affected_rows: affected_rows)
            else
              rows = stmt.to_a

              affected_rows = if raw_connection.total_changes > total_changes_before_query
                raw_connection.changes
              else
                0
              end

              ActiveRecord::Result.new(stmt.columns, rows, stmt.types.map { |t| type_map.lookup(t) }, affected_rows: affected_rows)
            end
          ensure
            stmt.close unless prepare
          end
          verified!

          notification_payload[:affected_rows] = affected_rows
          notification_payload[:row_count] = result&.length || 0
          result
        end

        def cast_result(result)
          # Given that SQLite3 doesn't have a Result type, raw_execute already returns an ActiveRecord::Result
          # so we have nothing to cast here.
          result
        end
      end
    end
  end
end
```

## Column Object

Activerecord ask to implement a an instanciation of `ConnectionAdapters::Column` this object describe the content of each column. What the adapter is to translate the column return by the database specific library into an activerecord comprehensible object. Usually, each connector need to implement a class that inherit Column to handle specific treatemnt. But here, we will keep it simple and simply implement `new_column_from_field`

```ruby
# schema_statement.rb

# ...

  def new_column_from_field(table_name, field, definitions)
    # Here I should return the row id
    default_function = nil

    Column.new(
      field["name"],
      lookup_cast_type(field["type"]),
      field["dflt_value"],
      fetch_type_metadata(field["type"]),
      field["notnull"].to_i == 0,
      default_function,
      collation: field["collation"]
    )
  end

# ...
```

## Statement Pool

To work properly, activerecord use a statement pool to store currents statement, limit the number of statement in this pool. By defauylt the method to instantiate the pool do nothing. We need to at least create a basic one.

```ruby
# ar_connector.rb

def build_statement_pool
  ConnectionAdapters::StatementPool.new(self.class.type_cast_config_to_integer(@config[:statement_limit]))
end
```

# Basic ActiveRecord model binding

The goal of activrecord is to handle our tables and its data as if it is a ruby object. To do so we want to do the binding and some basic manipulation.

```ruby
  class Show < ActiveRecord::Base
  end

  Show.create(name: "Breaking Bad", episodes: 42)
  Show.count
  Show.first.name
```

To create a ruby object from the query result, we need to do some introspection of the db to extract the column that will become accessors in our object

```ruby
def column_definitions(table_name)
  structure = internal_exec_query("PRAGMA table_info(#{quote_table_name(table_name)})", "SCHEMA", allow_retry: true)
  raise ActiveRecord::StatementInvalid.new("Could not find table '#{table_name}'", connection_pool: @pool) if structure.empty?
  structure.to_a
end

```

## The trick of update ruby object

With what we have done, we have a probleme because of the following

```ruby
  show = Show.create(name: "Breaking Bad", episodes: 42)
  show.id # => return nil
```

The problem is that the id is not return, the create basically have this chain of call : `create` -> `_create_record` -> `insert` -> `_exec_insert` -> `_exec_insert` -> `sql_for_insert`
Looking for `sql_for_insert`, it first check is the db support returning value. So we have to declare that our db is able to return the id on insert using the `RETURNING` SQL statement.

```ruby
def supports_insert_returning?
  true
end
```

<div class="mermaid">
  classDiagram
    class AbstractAdapter
    class Quoting
    class DatabaseStatements
    class SchemaStatements
    clsss MyAdapter
    clsss Column
    clsss StatementsPool
    
    MyAdapter <|-- AbstractAdapter
    MyAdapter *-- Column
    MyAdapter *-- StatementsPool 
    MyAdapter ..> Quoting : includes
    MyAdapter ..> DatabaseStatements : includes
    MyAdapter ..> SchemaStatements : includes
</div>
