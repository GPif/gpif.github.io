---
title: Understande Activerecord connector and build your own - Second part
mermaid: true
date: 2026-07-10 10:00:00 +0200
categories: [dev, ruby]
tags: [ruby, activerecord, database]     # TAG names should always be lowercase
compress_html: false
---

```bash
bundle gem arsimple
```

Add dependecies :

  spec.add_dependency "activerecord"
  spec.add_dependency "sqlite3"
  

lib/active_record/connection_adapters/my_adapter.rb

```ruby
# lib/active_record/connection_adapters/my_adapter.rb

require "active_record"
require "active_record/connection_adapters/abstract_adapter"

module ActiveRecord
    module ConnectionAdapters
        class MyAdapter < AbstractAdapter
        end
    end
end
```

do not forget to require our connector :

```ruby
# lib/arsimple.rb

require "active_record/connection_adapters/my_adapter"
```


# TDD

## Connection 

Test :

```ruby
    it "connect to the db" do

        ActiveRecord::Base.establish_connection(
          adapter: 'my_adapter',
          database: ':memory:' # As it is sqlite
        )
        expect(ActiveRecord::Base.connection.class).to eq(ActiveRecord::ConnectionAdapters::MyAdapter)
    end
```

Error :

```
    ActiveRecord::AdapterNotFound:
       Database configuration specifies nonexistent 'arconnector' adapter. Available adapters are: mysql2, postgresql, sqlite3, trilogy. Ensure that the adapter is spelled correctly in config/database.yml and that you've added the necessary adapter gem to your Gemfile if it's not in the list of available adapters.
```

Fix :

```ruby
    register("my_adapter", "ActiveRecord::ConnectionAdapters::MyAdapter", "active_record/connection_adapters/my_adapter")
```

## Schema statements

Test :

```ruby
    it "create a table" do
      expect {
        ActiveRecord::Schema.define(version: 1) do
          create_table :shows, force: true do |t|
            t.string :name
          end
        end
      }.not_to raise_error
    end
```

Error :

```
ActiveRecord::ConnectionAdapters::Quoting::ClassMethods#quote_column_name': NotImplementedError (NotImplementedError)
```

Here we need to implement the `quote_column_name` and a bunch of unimplemented 

First complete the structure :

```
quoting.rb
database_statements.rb
schema_statements.rb
```

Then requirement :

```ruby
require "active_record/connection_adapters/my/quoting"
require "active_record/connection_adapters/my/database_statements"
require "active_record/connection_adapters/my/schema_statements"
```

And implement the minimum required methods :


MyAdapter :
 * `native_database_types`
 * `reconnect`

Quoting :
 * `quote_column_name`

DatabaseStatements :
 * `write_query?`
 * `preform_query`
 * `cast_result`

SchemaStatements :
* `data_source_sql`


```ruby
module ActiveRecord
  module ConnectionAdapters
    module My
      module Quoting # :nodoc:
        extend ActiveSupport::Concern # :nodoc:
        module ClassMethods # :nodoc:
          def quote_column_name(column_name)
            %("#{column_name.to_s.gsub('"', '""')}")
          end
        end
      end
    end
  end
end
```

```ruby
# frozen_string_literal: true

module ActiveRecord
  module ConnectionAdapters
    module My
      module DatabaseStatements
        # Determines whether the SQL statement is a write query.
        def write_query?(sql)
          read_query = ActiveRecord::ConnectionAdapters::AbstractAdapter.build_read_query_regexp(
            :pragma
          )
          !read_query.match?(sql)
        end

        private

        def perform_query(raw_connection, intent, binds, type_casted_binds, prepare:, notification_payload:, batch:)
          binding.irb if batch

          total_changes_before_query = raw_connection.total_changes
          stmt = raw_connection.prepare(intent)
          begin
            result = if stmt.column_count.zero? # No return
                       stmt.step
                       affected_rows = raw_connection.total_changes > total_changes_before_query ? raw_connection.changes : 0
                       ActiveRecord::Result.empty(affected_rows: affected_rows)
                     else
                       rows = stmt.to_a
                       affected_rows = raw_connection.total_changes > total_changes_before_query ? raw_connection.changes : 0
                       ActiveRecord::Result.new(stmt.columns, rows, stmt.types.map do |t|
                         type_map.lookup(t)
                       end, affected_rows: affected_rows)
                     end
          ensure
            stmt.close
          end
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

```ruby
# frozen_string_literal: true

module ActiveRecord
  module ConnectionAdapters
    module My
      module SchemaStatements
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

```ruby
# frozen_string_literal: true

require "active_record"
require "active_record/connection_adapters/abstract_adapter"

require "active_record/connection_adapters/my/quoting"
require "active_record/connection_adapters/my/database_statements"
require "active_record/connection_adapters/my/schema_statements"

require "sqlite3"

module ActiveRecord
  module ConnectionAdapters
    class MyAdapter < AbstractAdapter
      include My::Quoting
      include My::DatabaseStatements
      include My::SchemaStatements

      class << self
        def new_client
          ::SQLite3::Database.new(":memory:")
        rescue Errno::ENOENT => e
          raise ActiveRecord::NoDatabaseError if e.message.include?("No such file or directory")

          raise
        end

        def native_database_types
          {
            primary_key: "integer PRIMARY KEY AUTOINCREMENT NOT NULL",
            string: { name: "varchar" },
            text: { name: "text" },
            integer: { name: "integer" },
            float: { name: "float" },
            decimal: { name: "decimal" },
            datetime: { name: "datetime" },
            time: { name: "time" },
            date: { name: "date" },
            binary: { name: "blob" },
            boolean: { name: "boolean" },
            json: { name: "json" }
          }
        end
      end

      def reconnect
        @raw_connection = self.class.new_client
      end
    end
    register("my_adapter", "ActiveRecord::ConnectionAdapters::MyAdapter",
             "active_record/connection_adapters/my_adapter")
  end
end

```

## CRUD

### Create

Test :

```ruby
  context "with connextion and schema" do
    before(:context) do
      ActiveRecord::Base.establish_connection(
        adapter: "my_adapter",
        database: ":memory:"
      )

      ActiveRecord::Schema.define(version: 1) do
        create_table :shows, force: true do |t|
          t.string :name
          t.integer :episodes
        end
      end
    end

    before(:example) do
      test_record = Class.new(ActiveRecord::Base)

      stub_const("Show", test_record)
    end

    it "create record" do
      s = Show.create(name: "Breaking Bad", episodes: 42)
      assert_not_nil(s.id)
      assert_equal 1, Show.count
      assert_equal "Breaking Bad", Show.first.name
    end
  end
```

Error

```
NoMethodError:
       undefined method 'column_definitions' for an instance of ActiveRecord::ConnectionAdapters::MyAdapter
```


```ruby
  # MyAdapter  

  def column_definitions(table_name)
    structure = internal_exec_query("PRAGMA table_info(#{quote_table_name(table_name)})", "SCHEMA",
                                    allow_retry: true)
    if structure.empty?
      raise ActiveRecord::StatementInvalid.new("Could not find table '#{table_name}'",
                                               connection_pool: @pool)
    end

    structure.to_a
  end
```

```ruby
# schema_statement

private

def new_column_from_field(_table_name, field, _definitions)
  default_function = nil

  Column.new(
    field["name"],
    lookup_cast_type(field["type"]),
    field["dflt_value"],
    fetch_type_metadata(field["type"]),
    field["notnull"].to_i.zero?,
    default_function,
    collation: field["collation"]
  )
end
```

```ruby
# database_statements 
        
def primary_keys(_tables)
  r = internal_exec_query("PRAGMA table_info([shows]);")
  pk = r.to_a.find { |r| r["pk"] == 1 }
  return pk["name"] if pk

  nil
end
```

```ruby
# database_statements 
        

def perform_query(raw_connection, intent, binds, type_casted_binds, prepare:, notification_payload:, batch:)
# ...

# Handle bindings for prepared statements
unless binds.nil? || binds.empty?
  stmt.bind_params(type_casted_binds)
end

# ...
end
```



